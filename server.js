require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Nanti ganti "*" dengan URL Vercel Anda untuk keamanan produksi
        methods: ["GET", "POST"]
    }
});

// Koneksi ke MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/webradio')
    .then(() => console.log('Terhubung ke MongoDB'))
    .catch(err => console.error('Gagal koneksi MongoDB:', err));

// Skema Database Pesan
const messageSchema = new mongoose.Schema({
    messageId: String,
    channel: String,
    username: String,
    text: String,
    image: String,
    type: { type: String, default: 'text' },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// Menyajikan file HTML yang ada di folder yang sama dengan server.js
app.use(express.static(__dirname));

// Memastikan rute utama (/) langsung mengirim file index.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Objek untuk melacak pengguna aktif: { socketId: { username, channel } }
const activeUsers = {};

// Fungsi pembantu untuk mengirim daftar pengguna terbaru ke ruangan tertentu
function updateUserList(channel) {
    if (!channel) return;
    const usersInChannel = Object.entries(activeUsers)
        .filter(([id, u]) => u.channel === channel)
        .map(([id, u]) => ({ id, username: u.username, media: u.media }));
    io.to(channel).emit('userListUpdate', usersInChannel);
}

// Fungsi untuk memastikan username unik di dalam sebuah channel
function getUniqueUsername(requestedName, channel, socketId) {
    let baseName = requestedName || 'USER';
    let uniqueName = baseName;
    let counter = 1;
    
    let isNameTaken = true;
    while (isNameTaken) {
        isNameTaken = Object.entries(activeUsers).some(([id, user]) => {
            return user.channel === channel && user.username === uniqueName && id !== socketId;
        });
        if (isNameTaken) {
            uniqueName = `${baseName}(${counter})`;
            counter++;
        }
    }
    return uniqueName;
}

io.on('connection', (socket) => {
    console.log(`Pengguna terhubung dengan ID: ${socket.id}`);
    activeUsers[socket.id] = { username: 'USER', channel: null, media: { audio: false, video: false } };

    // Mengatur perpindahan channel (ruangan) berdasarkan kode angka
    socket.on('joinChannel', (data) => {
        const { channel, username } = data;
        
        if (socket.currentChannel) {
            socket.leave(socket.currentChannel);
            const oldChannel = socket.currentChannel;
            socket.currentChannel = null;
            activeUsers[socket.id].channel = null;
            updateUserList(oldChannel); // Beri tahu channel lama bahwa orang ini keluar
            socket.to(oldChannel).emit('userLeft', socket.id);
        }

        socket.join(channel);
        socket.currentChannel = channel;
        
        // Dapatkan nama yang unik agar tidak bertabrakan
        const uniqueName = getUniqueUsername(username, channel, socket.id);
        activeUsers[socket.id].username = uniqueName;
        activeUsers[socket.id].channel = channel;
        
        socket.emit('usernameAssigned', uniqueName); // Kirim balik nama yang disetujui ke klien
        updateUserList(channel); // Beri tahu channel baru ada orang yang masuk
        socket.to(channel).emit('userJoined', { id: socket.id, username: uniqueName });

        // Tarik riwayat pesan dari MongoDB
        Message.find({ channel }).sort({ createdAt: 1 }).limit(50)
            .then(messages => socket.emit('chatHistory', messages))
            .catch(err => console.error(err));
    });

    // Fungsi untuk keluar dari channel (Disconnect / Off)
    socket.on('leaveChannel', () => {
        if (socket.currentChannel) {
            const oldChannel = socket.currentChannel;
            socket.leave(oldChannel);
            socket.currentChannel = null;
            if (activeUsers[socket.id]) activeUsers[socket.id].channel = null;
            updateUserList(oldChannel);
            socket.to(oldChannel).emit('userLeft', socket.id);
        }
    });

    // Saat pengguna mengganti nama ID mereka di layar
    socket.on('updateUsername', (username) => {
        if (activeUsers[socket.id]) {
            const uniqueName = getUniqueUsername(username, socket.currentChannel, socket.id);
            activeUsers[socket.id].username = uniqueName;
            socket.emit('usernameAssigned', uniqueName); // Perbarui nama di layar klien
            updateUserList(socket.currentChannel);
        }
    });

    // Saat pengguna menyalakan/mematikan mic atau kamera
    socket.on('mediaStateChange', (mediaState) => {
        if (activeUsers[socket.id]) {
            activeUsers[socket.id].media = mediaState;
            if (socket.currentChannel) {
                io.to(socket.currentChannel).emit('userMediaUpdate', { id: socket.id, media: mediaState });
            }
        }
    });

    // Menerima pesan teks dan menyiarkannya ke semua orang di channel yang sama
    socket.on('textMessage', async (text) => {
        if (socket.currentChannel && activeUsers[socket.id]) {
            const username = activeUsers[socket.id].username;
            // Membuat ID unik acak (Kombinasi waktu & string acak)
            const messageId = Date.now().toString(36) + Math.random().toString(36).substr(2);

            // Simpan ke MongoDB
            const newMsg = new Message({
                messageId, channel: socket.currentChannel, username, text, type: 'text'
            });
            await newMsg.save().catch(err => console.error(err));

            io.to(socket.currentChannel).emit('textMessage', { id: messageId, username, text });
        }
    });

    // Menerima status sedang mengetik dan menyiarkannya
    socket.on('typing', (isTyping) => {
        if (socket.currentChannel && activeUsers[socket.id]) {
            const username = activeUsers[socket.id].username;
            socket.to(socket.currentChannel).emit('typing', { username, isTyping });
        }
    });

    // Menerima permintaan hapus pesan dan menyebarkannya
    socket.on('deleteMessage', async (messageId) => {
        if (socket.currentChannel) {
            await Message.deleteOne({ messageId }).catch(err => console.error(err));
            io.to(socket.currentChannel).emit('messageDeleted', messageId);
        }
    });

    // Menerima data gambar dan menyiarkannya ke semua klien lain
    socket.on('imageMessage', async (imageBase64) => {
        if (socket.currentChannel) {
            const username = activeUsers[socket.id].username;
            const messageId = Date.now().toString(36) + Math.random().toString(36).substr(2);

            // Simpan ke MongoDB
            const newMsg = new Message({
                messageId, channel: socket.currentChannel, username, image: imageBase64, type: 'image'
            });
            await newMsg.save().catch(err => console.error(err));

            io.to(socket.currentChannel).emit('imageMessage', { id: messageId, username, image: imageBase64 });
        }
    });

    // Menerima sinyal WebRTC untuk Video/Audio Call dan Screen Share
    socket.on('webrtcSignal', (data) => {
        if (socket.currentChannel) {
            io.to(data.target).emit('webrtcSignal', { sender: socket.id, signal: data.signal });
        }
    });

    socket.on('disconnect', () => {
        const channel = activeUsers[socket.id]?.channel;
        delete activeUsers[socket.id];
        if (channel) {
            socket.to(channel).emit('userLeft', socket.id);
            updateUserList(channel); // Perbarui daftar karena ada yang terputus
        }
        console.log(`Pengguna terputus: ${socket.id}`);
    });
});

// Menjalankan server di lokal, atau mengekspornya untuk Vercel Serverless
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server Radio berjalan di http://localhost:${PORT}`);
    });
}
module.exports = server;