const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

const MONGO_URI = process.env.MONGO_URI; 
const SECRET_CODE = process.env.SECRET_CODE || "1234";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error(err));

const messageSchema = new mongoose.Schema({
  username: String,
  text: String,
  fileName: String, 
  type: { type: String, enum: ['text', 'image', 'document', 'audio'], default: 'text' },
  expiresAt: { type: Date, index: { expires: '0s' } }, 
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('join', async ({ code, username }) => {
    if (code === SECRET_CODE) {
      currentUser = username;
      socket.emit('auth-success');
      
      // Default: Join Normal Room
      socket.join('room-normal');
      
      // Load Normal History (Messages with NO expiry)
      const history = await Message.find({ expiresAt: { $exists: false } })
                                   .sort({ timestamp: 1 }).limit(50);
      socket.emit('load-history', history);
    } else {
      socket.emit('auth-fail');
    }
  });

  // --- THIS IS THE MISSING LINK FOR THE TOGGLE ---
  socket.on('switch-mode', async (mode) => {
    if (mode === 'temp') {
        socket.leave('room-normal');
        socket.join('room-temp');
        // Load Temp History (Messages WITH expiry)
        const history = await Message.find({ expiresAt: { $exists: true } })
                                     .sort({ timestamp: 1 }).limit(50);
        socket.emit('load-history', history);
    } else {
        socket.leave('room-temp');
        socket.join('room-normal');
        // Load Normal History
        const history = await Message.find({ expiresAt: { $exists: false } })
                                     .sort({ timestamp: 1 }).limit(50);
        socket.emit('load-history', history);
    }
  });

  socket.on('chat message', async (data) => {
    if (!currentUser) return;
    
    const msgData = {
      username: currentUser,
      text: data.text,
      fileName: data.fileName || "",
      type: data.type || 'text'
    };

    let room = 'room-normal';
    
    // If Temp Mode is active, add expiry and change room
    if (data.isTemp) {
      msgData.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 
      room = 'room-temp';
    }

    const newMsg = new Message(msgData);
    await newMsg.save();
    
    // Broadcast ONLY to the specific room
    io.to(room).emit('chat message', newMsg);
  });

  socket.on('typing', () => { if (currentUser) socket.broadcast.emit('display-typing', currentUser); });
  socket.on('stop-typing', () => { socket.broadcast.emit('hide-typing'); });
  socket.on('unsend-message', async (id) => { await Message.findByIdAndDelete(id); io.emit('message-unsent', id); });
  socket.on('edit-message', async ({ messageId, newText }) => { await Message.findByIdAndUpdate(messageId, { text: newText }); io.emit('message-edited', { messageId, newText }); });
});

server.listen(3000, () => { console.log('Server running on 3000'); });
