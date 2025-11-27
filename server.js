const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Limit increased to 50MB to allow sending Voice Notes and Images
const io = new Server(server, { maxHttpBufferSize: 5e7 });

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI; 
const SECRET_CODE = process.env.SECRET_CODE || "1234";

// --- DATABASE CONNECTION ---
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB error:', err));

// --- DATA MODEL ---
const messageSchema = new mongoose.Schema({
  username: String,
  text: String,
  fileName: String, 
  type: { type: String, enum: ['text', 'image', 'audio', 'document'], default: 'text' },
  reactions: { type: Map, of: String },
  isEdited: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// --- SERVE FRONTEND ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// --- TRACKING ONLINE USERS ---
const onlineUsers = new Map(); // Maps socket.id -> username

io.on('connection', (socket) => {
  let currentUser = null;

  // 1. JOIN ROOM
  socket.on('join', async ({ code, username }) => {
    if (code === SECRET_CODE) {
      currentUser = username;
      onlineUsers.set(socket.id, username);
      
      socket.emit('auth-success');
      
      // Load History
      const history = await Message.find().sort({ timestamp: 1 }).limit(100);
      socket.emit('load-history', history);

      // Broadcast Online Status
      io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));
    } else {
      socket.emit('auth-fail');
    }
    // --- VIDEO CALL SIGNALING (Add this at the bottom of io.on) ---
  socket.on("call-user", (data) => {
    socket.broadcast.emit("call-made", { offer: data.offer, socket: socket.id });
  });

  socket.on("make-answer", (data) => {
    socket.to(data.to).emit("answer-made", { socket: socket.id, answer: data.answer });
  });

  socket.on("ice-candidate", (data) => {
    socket.to(data.to).emit("ice-candidate", { candidate: data.candidate });
  });
  
  socket.on("hang-up", () => {
    socket.broadcast.emit("call-ended");
  });
  });

  // 2. DISCONNECT
  socket.on('disconnect', () => {
    if (currentUser) {
      onlineUsers.delete(socket.id);
      io.emit('update-online-users', Array.from(new Set(onlineUsers.values())));
    }
  });

  // 3. SEND MESSAGE (Text, Image, Audio)
 socket.on('chat message', async (data) => {
    if (!currentUser) return;
    const newMsg = new Message({
      username: currentUser,
      text: data.text,
      fileName: data.fileName || "", 
      type: data.type || 'text',
      reactions: {}
    });
    await newMsg.save();
    io.emit('chat message', newMsg);
  });

  // 4. TYPING INDICATOR
  socket.on('typing', () => {
    if (currentUser) socket.broadcast.emit('display-typing', currentUser);
  });
  
  socket.on('stop-typing', () => {
    socket.broadcast.emit('hide-typing');
  });

  // 5. REACTIONS
  socket.on('react', async ({ messageId, reaction }) => {
    if (!currentUser) return;
    const msg = await Message.findById(messageId);
    if (msg) {
      // Toggle reaction
      if (msg.reactions.get(currentUser) === reaction) {
        msg.reactions.delete(currentUser);
      } else {
        msg.reactions.set(currentUser, reaction);
      }
      await msg.save();
      io.emit('update-reaction', { messageId, reactions: msg.reactions });
    }
  });

  // 6. EDIT MESSAGE
  socket.on('edit-message', async ({ messageId, newText }) => {
    const msg = await Message.findById(messageId);
    if (msg && msg.username === currentUser) {
      msg.text = newText;
      msg.isEdited = true;
      await msg.save();
      io.emit('message-edited', { messageId, newText });
    }
  });

  // 7. UNSEND MESSAGE
  socket.on('unsend-message', async (messageId) => {
    const msg = await Message.findById(messageId);
    if (msg && msg.username === currentUser) {
      await Message.findByIdAndDelete(messageId);
      io.emit('message-unsent', messageId);
    }
  });
});

server.listen(3000, () => {
  console.log('Server running on 3000');
});


