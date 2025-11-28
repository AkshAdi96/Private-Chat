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
  // TTL INDEX: This tells MongoDB to delete the document when the time matches 'expiresAt'
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
      // Only load messages that haven't expired yet
      const history = await Message.find().sort({ timestamp: 1 }).limit(50);
      socket.emit('load-history', history);
    } else {
      socket.emit('auth-fail');
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

    // IF TEMPORARY MODE IS ON: Set expiration date to 24 hours from now
    if (data.isTemp) {
      msgData.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 
    }

    const newMsg = new Message(msgData);
    await newMsg.save();
    io.emit('chat message', newMsg);
  });

  socket.on('typing', () => { if (currentUser) socket.broadcast.emit('display-typing', currentUser); });
  socket.on('stop-typing', () => { socket.broadcast.emit('hide-typing'); });
  
  socket.on('unsend-message', async (id) => { 
    await Message.findByIdAndDelete(id); 
    io.emit('message-unsent', id); 
  });
  
  socket.on('edit-message', async ({ messageId, newText }) => { 
    await Message.findByIdAndUpdate(messageId, { text: newText }); 
    io.emit('message-edited', { messageId, newText }); 
  });
});

server.listen(3000, () => { console.log('Server running on 3000'); });
