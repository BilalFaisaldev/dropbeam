import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import mime from 'mime-types';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100 MB
  cors: {
    origin: '*',
  }
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FILE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Room-based state store
const rooms = {
  'public': {
    id: 'public',
    passcode: null,
    clipboardText: '',
    textHistory: [],
    sharedFiles: [],
    chatMessages: []
  }
};

// Global fast-lookup map for downloads: fileId -> file metadata
const allFilesMap = new Map();

// Active device mapping: socket.id -> { id, ip, deviceName, type, os, joinedAt, roomId }
const connectedDevices = {};

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniquePrefix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniquePrefix}-${safeName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get or create room
function getOrCreateRoom(roomId, passcode = null) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      passcode: passcode || null,
      clipboardText: '',
      textHistory: [],
      sharedFiles: [],
      chatMessages: []
    };
    console.log(`🏠 Custom Room Created: ${roomId} (Passcode: ${passcode ? 'Yes' : 'No'})`);
  }
  return rooms[roomId];
}

// HTTP API Routes

// File Upload Endpoint (takes Room Headers)
app.post('/api/upload', upload.array('files'), (req, res) => {
  const roomId = req.headers['x-room-id'] || 'public';
  const selfDestruct = req.headers['x-self-destruct'] === 'true';
  const roomPasscode = req.headers['x-room-passcode'] || null;

  // Validate room passcode if room exists
  const room = rooms[roomId];
  if (room && room.passcode && room.passcode !== roomPasscode) {
    return res.status(403).json({ error: 'Invalid room passcode' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Ensure room exists
  const targetRoom = getOrCreateRoom(roomId, roomPasscode);

  const uploadedFilesInfo = req.files.map(file => {
    const fileId = Math.random().toString(36).substring(2, 11);
    const newFile = {
      id: fileId,
      roomId: roomId,
      name: file.originalname,
      tempName: file.filename,
      size: file.size,
      mimeType: mime.lookup(file.originalname) || 'application/octet-stream',
      uploadedAt: Date.now(),
      expiresAt: Date.now() + FILE_EXPIRY_MS,
      selfDestruct: selfDestruct
    };

    targetRoom.sharedFiles.push(newFile);
    allFilesMap.set(fileId, newFile);
    return newFile;
  });

  // Broadcast files added to that room only
  io.to(roomId).emit('files-added', uploadedFilesInfo);

  res.status(200).json({ success: true, files: uploadedFilesInfo });
});

// File Download Endpoint
app.get('/api/download/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const file = allFilesMap.get(fileId);
  
  if (!file) {
    return res.status(404).send('File not found or expired');
  }

  const filePath = path.join(UPLOADS_DIR, file.tempName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File physical copy not found');
  }

  // Serve file
  res.download(filePath, file.name, (err) => {
    if (err) {
      console.error(`Error downloading file ${file.name}:`, err);
      return;
    }

    // Handle self-destruct condition
    if (file.selfDestruct) {
      console.log(`🔥 Self-destructing file downloaded: ${file.name}`);
      
      // Async filesystem deletion
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error(`Error unlinking self-destruct file ${file.tempName}:`, unlinkErr);
      });
      
      // Clean up server lists
      allFilesMap.delete(fileId);
      const room = rooms[file.roomId];
      if (room) {
        room.sharedFiles = room.sharedFiles.filter(f => f.id !== fileId);
      }
      
      // Notify clients
      io.to(file.roomId).emit('file-removed', fileId);
    }
  });
});

// File Preview Endpoint (direct render)
app.get('/api/preview/:fileId', (req, res) => {
  const file = allFilesMap.get(req.params.fileId);
  if (!file) {
    return res.status(404).send('File not found or expired');
  }

  const filePath = path.join(UPLOADS_DIR, file.tempName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File physical copy not found');
  }

  res.setHeader('Content-Type', file.mimeType);
  res.sendFile(filePath);
});

// Socket.io Real-time Operations
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address.replace('::ffff:', '');
  socket.roomId = 'public'; // Default room

  // Handle Room Switching & Authentication
  socket.on('join-room', ({ roomId, passcode }) => {
    const existingRoom = rooms[roomId];

    // Passcode validation
    if (existingRoom && existingRoom.passcode && existingRoom.passcode !== passcode) {
      socket.emit('join-error', 'Incorrect passcode for this private room.');
      return;
    }

    // Leave old room
    socket.leave(socket.roomId);
    const oldRoomId = socket.roomId;
    
    // Join new room
    socket.join(roomId);
    socket.roomId = roomId;
    socket.passcode = passcode || null;

    // Create room if it doesn't exist
    const room = getOrCreateRoom(roomId, passcode);

    // Update active device mapping
    if (connectedDevices[socket.id]) {
      connectedDevices[socket.id].roomId = roomId;
    }

    // Acknowledge successful join
    socket.emit('join-success', {
      roomId,
      clipboardText: room.clipboardText,
      textHistory: room.textHistory,
      chatMessages: room.chatMessages,
      files: room.sharedFiles.map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        uploadedAt: f.uploadedAt,
        expiresAt: f.expiresAt,
        selfDestruct: f.selfDestruct
      }))
    });

    // Notify old and new room users of device list changes
    broadcastRoomDevices(oldRoomId);
    broadcastRoomDevices(roomId);
  });

  // Device registration
  socket.on('register-device', (deviceInfo) => {
    connectedDevices[socket.id] = {
      id: socket.id,
      ip: clientIp,
      deviceName: deviceInfo.deviceName || 'Unknown Device',
      type: deviceInfo.type || 'desktop',
      os: deviceInfo.os || 'Unknown OS',
      joinedAt: Date.now(),
      roomId: socket.roomId
    };

    socket.join(socket.roomId);
    broadcastRoomDevices(socket.roomId);
  });

  // Clipboard updates
  socket.on('clipboard-update', (text) => {
    const room = rooms[socket.roomId];
    if (room) {
      room.clipboardText = text;
      socket.to(socket.roomId).emit('clipboard-sync', text);
    }
  });

  // Add text history snippet
  socket.on('history-add', (text) => {
    const room = rooms[socket.roomId];
    if (!room || !text || text.trim() === '') return;

    const snippet = {
      id: Math.random().toString(36).substring(2, 11),
      content: text,
      timestamp: Date.now()
    };

    room.textHistory.unshift(snippet);
    if (room.textHistory.length > 50) room.textHistory.pop();

    io.to(socket.roomId).emit('history-updated', room.textHistory);
  });

  // Delete history snippet
  socket.on('history-delete', (id) => {
    const room = rooms[socket.roomId];
    if (room) {
      room.textHistory = room.textHistory.filter(item => item.id !== id);
      io.to(socket.roomId).emit('history-updated', room.textHistory);
    }
  });

  // Real-time chat messages
  socket.on('chat-message', (msgText) => {
    const room = rooms[socket.roomId];
    const dev = connectedDevices[socket.id];
    if (!room || !dev || !msgText || msgText.trim() === '') return;

    const chatMsg = {
      id: Math.random().toString(36).substring(2, 11),
      senderId: socket.id,
      senderName: dev.deviceName,
      message: msgText,
      timestamp: Date.now(),
      deviceType: dev.type
    };

    room.chatMessages.push(chatMsg);
    if (room.chatMessages.length > 100) room.chatMessages.shift(); // Limit chat history

    io.to(socket.roomId).emit('chat-received', chatMsg);
  });

  // Delete file manually
  socket.on('file-delete', (id) => {
    const file = allFilesMap.get(id);
    if (file && file.roomId === socket.roomId) {
      const filePath = path.join(UPLOADS_DIR, file.tempName);
      
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.error(`Error deleting file ${file.tempName}:`, err);
      });

      allFilesMap.delete(id);
      const room = rooms[socket.roomId];
      if (room) {
        room.sharedFiles = room.sharedFiles.filter(f => f.id !== id);
      }

      io.to(socket.roomId).emit('file-removed', id);
    }
  });

  socket.on('get-state', () => {
    const room = rooms[socket.roomId];
    if (room) {
      socket.emit('init-state', {
        clipboardText: room.clipboardText,
        textHistory: room.textHistory,
        files: room.sharedFiles.map(f => ({
          id: f.id,
          name: f.name,
          size: f.size,
          mimeType: f.mimeType,
          uploadedAt: f.uploadedAt,
          expiresAt: f.expiresAt,
          selfDestruct: f.selfDestruct
        }))
      });
    }
  });

  socket.on('disconnect', () => {
    const dev = connectedDevices[socket.id];
    if (dev) {
      const rId = dev.roomId;
      delete connectedDevices[socket.id];
      broadcastRoomDevices(rId);
    }
  });
});

// Helper to broadcast room devices
function broadcastRoomDevices(roomId) {
  const roomDevices = Object.values(connectedDevices).filter(d => d.roomId === roomId);
  io.to(roomId).emit('devices-updated', roomDevices);
}

// Periodic cleanup of expired files (runs every 10 seconds)
setInterval(() => {
  const now = Date.now();
  
  for (const [fileId, file] of allFilesMap.entries()) {
    if (now > file.expiresAt) {
      const filePath = path.join(UPLOADS_DIR, file.tempName);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.error(`Cleanup failed for ${file.tempName}:`, err);
      });

      // Remove from memory
      allFilesMap.delete(fileId);
      const room = rooms[file.roomId];
      if (room) {
        room.sharedFiles = room.sharedFiles.filter(f => f.id !== fileId);
      }

      // Notify clients
      io.to(file.roomId).emit('file-removed', fileId);
      console.log(`⏰ Automatically expired and deleted: ${file.name}`);
    }
  }
}, 10000);

// Local IP extraction
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Boot
server.listen(PORT, '0.0.0.0', () => {
  const localIPs = getLocalIPs();
  console.log('\n==================================================');
  console.log('⚡ DropBeam WiFi - Active Room Controller');
  console.log(`📡 Local Server: http://localhost:${PORT}`);
  localIPs.forEach(ip => console.log(`   👉 http://${ip}:${PORT}`));
  console.log('==================================================\n');
});
