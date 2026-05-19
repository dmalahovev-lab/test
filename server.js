const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket'],
    allowUpgrades: false,
    maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) { fs.mkdirSync(UPLOADS_DIR); }

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

const CF_API_TOKEN = 'cfut_nRdMko8VGb1R6yP645vkggXNTbNX203tFTXhGMqk9f4c21c9';
const CF_ACCOUNT_ID = '315776b94c3e5574096cfecc515248bc';
const CF_KV_ID = '1b46ee655788445ca7b277fb8634dca0';

let db = { users: {}, messages: [], groups: {} };

// Универсальная функция для железных HTTPS-запросов к Cloudflare KV
// Железная функция запросов к Cloudflare KV с расчётом Content-Length
function cfRequest(method, payload, callback) {
    const bodyData = payload ? String(payload) : '';
    const options = {
        hostname: '://cloudflare.com',
        path: `/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_ID}/values/danumes_main_db`,
        method: method,
        headers: {
            'Authorization': `Bearer ${CF_API_TOKEN}`,
            'Content-Type': 'text/plain; charset=utf-8'
        }
    };

    // Обязательный заголовок для PUT запросов, иначе Cloudflare KV сбросит пакет
    if (method === 'PUT') {
        options.headers['Content-Length'] = Buffer.byteLength(bodyData, 'utf8');
    }

    const req = https.request(options, (res) => {
        let chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            const resBody = Buffer.concat(chunks).toString('utf8');
            callback(null, res.statusCode, resBody);
        });
    });

    req.on('error', (e) => callback(e, 0, null));
    if (method === 'PUT' && bodyData) {
        req.write(bodyData, 'utf8');
    }
    req.end();
}

async function loadDBFromCloudflare() {
    console.log("Загрузка базы из Cloudflare KV...");
    cfRequest('GET', null, (err, status, data) => {
        if (!err && status === 200 && data) {
            try {
                db = JSON.parse(data);
                fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
                console.log("✅ База Cloudflare успешно синхронизирована!");
            } catch (e) { console.error("Ошибка парсинга KV:", e); }
        } else { console.log("База в облаке пуста или недоступна, создаем структуру."); }
        if (!db || typeof db !== 'object') db = { users: {}, messages: [], groups: {} };
        if (!db.users) db.users = {};
        if (!db.messages) db.messages = [];
        if (!db.groups) db.groups = {};
    });
}
loadDBFromCloudflare();

async function saveDB() {
    try {
        const contentString = JSON.stringify(db, null, 2);
        fs.writeFileSync(DB_FILE, contentString);
        cfRequest('PUT', contentString, (err, status, responseText) => {
            if (!err && status === 200) { 
                console.log("☁️ Бэкап успешно сохранен в Cloudflare KV!"); 
            } else if (err) {
                console.error("Ошибка сети с Cloudflare:", err.message);
            } else {
                console.error(`Cloudflare вернул статус ${status}:`, responseText);
            }
        });
    } catch (e) { console.error("Ошибка записи бэкапа:", e); }
}

const usersOnline = {};

app.post('/api/register', (req, res) => {
    const { user, pass } = req.body;
    if (!user || !pass) return res.status(400).json({ message: 'Заполните все поля' });
    if (db.users[user]) return res.status(400).json({ message: 'Пользователь уже существует' });
    db.users[user] = { password: pass, avatar: null, friends: [] };
    saveDB();
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (!user || !pass) return res.status(400).json({ message: 'Заполните все поля' });
    if (user === 'Danumala' && !db.users['Danumala']) { db.users['Danumala'] = { password: 'danyajukovka', avatar: null, friends: [] }; saveDB(); }
    if (user === 'RunFly' && !db.users['RunFly']) { db.users['RunFly'] = { password: 'GGWWXXJJ2001', avatar: null, friends: [] }; saveDB(); }
    const account = db.users[user];
    if (!account || account.password !== pass) { return res.status(400).json({ message: 'Неверное имя пользователя или пароль' }); }
    res.json({ success: true });
});

app.post('/api/upload', (req, res) => {
    const { rawData, fileName, isImage } = req.body;
    if (!rawData || !fileName) return res.status(400).json({ message: 'Данные файла не переданы' });
    try {
        const base64Data = rawData.replace(/^data:.*;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = path.extname(fileName);
        const safeName = `file_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
        const filePath = path.join(UPLOADS_DIR, safeName);
        fs.writeFileSync(filePath, buffer);
        res.json({ url: `/uploads/${safeName}`, name: fileName, isImage: isImage });
    } catch(err) { res.status(500).json({ message: 'Ошибка записи файла' }); }
});

app.post('/api/messages/delete', (req, res) => {
    const { messageId, user } = req.body;
    const msgIndex = db.messages.findIndex(m => m.id === messageId);
    if (msgIndex !== -1) {
        const msg = db.messages[msgIndex];
        if (user === 'Danumala' || msg.author === user) {
            db.messages.splice(msgIndex, 1);
            saveDB();
            io.emit('msg_deleted', messageId);
            return res.json({ success: true });
        }
    }
    res.status(400).json({ message: 'Нет прав или сообщение не найдено' });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function sendActiveChatsAndFriends(socket, username) {
    if (!username || !db.users[username]) return;
    if (!db.users[username].friends) db.users[username].friends = [];
    const activeInteractions = new Set();
    db.messages.forEach(m => {
        if (m.type === 'private') {
            if (m.author === username) activeInteractions.add(m.to);
            if (m.to === username) activeInteractions.add(m.author);
        }
    });
    const activeChatsData = Array.from(activeInteractions).map(user => ({
        username: user,
        avatar: db.users[user] ? db.users[user].avatar : null,
        isOnline: !!usersOnline[user]
    }));
    const friendsData = db.users[username].friends.map(friend => ({
        username: friend,
        avatar: db.users[friend] ? db.users[friend].avatar : null,
        isOnline: !!usersOnline[friend]
    }));
    socket.emit('active_chats_list', activeChatsData);
    socket.emit('friends_list_data', friendsData);
}
io.on('connection', (socket) => {
    let sessionUser = null;

    socket.on('register_user', (username) => {
        if (!username) return;
        sessionUser = username;
        usersOnline[username] = socket.id;
        const userAvatar = db.users[username] ? db.users[username].avatar : null;
        socket.emit('auth_success_data', { avatar: userAvatar });
        sendActiveChatsAndFriends(socket, username);
        Object.keys(usersOnline).forEach(u => {
            const ts = io.sockets.sockets.get(usersOnline[u]);
            if (ts) sendActiveChatsAndFriends(ts, u);
        });
        sendGroupsList(socket);
    });

    function sendGroupsList(targetSocket) {
        if (!sessionUser) return;
        const userGroups = [];
        Object.keys(db.groups).forEach(groupId => {
            const group = db.groups[groupId];
            if (group.members && group.members.includes(sessionUser)) {
                userGroups.push({ id: groupId, name: group.name });
            }
        });
        targetSocket.emit('update_groups', userGroups);
    }

    socket.on('get_online_users', () => { if (sessionUser) sendActiveChatsAndFriends(socket, sessionUser); });

    socket.on('global_search_user', (query) => {
        if (!sessionUser || !query) return;
        const q = query.toLowerCase().trim();
        const results = Object.keys(db.users)
            .filter(username => username !== sessionUser && username.toLowerCase().includes(q))
            .map(username => ({
                username: username,
                avatar: db.users[username].avatar || null,
                isFriend: db.users[sessionUser].friends ? db.users[sessionUser].friends.includes(username) : false
            }));
        socket.emit('global_search_results', results);
    });

    socket.on('toggle_friend', (targetUser) => {
        if (!sessionUser || !db.users[sessionUser] || !db.users[targetUser]) return;
        if (!db.users[sessionUser].friends) db.users[sessionUser].friends = [];
        const index = db.users[sessionUser].friends.indexOf(targetUser);
        if (index === -1) { db.users[sessionUser].friends.push(targetUser); } else { db.users[sessionUser].friends.splice(index, 1); }
        saveDB();
        sendActiveChatsAndFriends(socket, sessionUser);
    });

    socket.on('leave_group', (groupId) => {
        if (!sessionUser || !db.groups[groupId]) return;
        const index = db.groups[groupId].members.indexOf(sessionUser);
        if (index !== -1) {
            db.groups[groupId].members.splice(index, 1);
            if (db.groups[groupId].members.length === 0) { delete db.groups[groupId]; }
            saveDB();
            sendGroupsList(socket);
            socket.emit('group_left_success');
        }
    });

    socket.on('create_private_group', (data) => {
        if (!sessionUser) return;
        const groupId = 'group_' + Date.now();
        const members = data.members;
        if (!members.includes(sessionUser)) members.push(sessionUser);
        db.groups[groupId] = { name: data.name, creator: sessionUser, members: members };
        saveDB();
        members.forEach(member => {
            const targetSocketId = usersOnline[member];
            if (targetSocketId) { const ts = io.sockets.sockets.get(targetSocketId); if (ts) sendGroupsList(ts); }
        });
    });

    socket.on('load_messages', (query) => {
        let history = [];
        if (query.type === 'news') {
            history = db.messages.filter(m => m.type === 'news');
        } else if (query.type === 'group') {
            const group = db.groups[query.id];
            if (group && group.members.includes(sessionUser)) history = db.messages.filter(m => m.type === 'group' && m.to === query.id);
        } else {
            history = db.messages.filter(m => m.type === 'private' && ((m.to === query.id && m.author === sessionUser) || (m.to === sessionUser && m.author === query.id)));
        }
        socket.emit('messages_history', history);
    });

    socket.on('send_msg', (data) => {
        if (data.type === 'news' && sessionUser !== 'Danumala') return;
        if (data.type === 'group') {
            const group = db.groups[data.to];
            if (!group || !group.members.includes(sessionUser)) return;
        }
        const newMsg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            type: data.type,
            to: data.to,
            author: sessionUser,
            text: data.text || '',
            image: data.image || null,
            fileUrl: data.fileUrl || null,
            fileName: data.fileName || null,
            time: new Date().toISOString(),
            read: false
        };
        db.messages.push(newMsg);
        saveDB();
        if (data.type === 'news') {
            io.emit('new_msg', newMsg);
        } else if (data.type === 'group') {
            const group = db.groups[data.to];
            group.members.forEach(member => { const ts = usersOnline[member]; if (ts) io.to(ts).emit('new_msg', newMsg); });
        } else {
            const ts = usersOnline[data.to];
            if (ts) {
                io.to(ts).emit('new_msg', newMsg);
                const targetSocket = io.sockets.sockets.get(ts);
                if (targetSocket) sendActiveChatsAndFriends(targetSocket, data.to);
            }
            socket.emit('new_msg', newMsg);
            sendActiveChatsAndFriends(socket, sessionUser);
        }
    });

    socket.on('mark_as_read', (data) => {
        let changed = false;
        db.messages.forEach(m => { if (m.type === 'private' && m.author === data.chatWith && m.to === sessionUser && !m.read) { m.read = true; changed = true; } });
        if (changed) { saveDB(); const ts = usersOnline[data.chatWith]; if (ts) io.to(ts).emit('chat_read_by_recipient', { readBy: sessionUser }); }
    });

    socket.on('typing_status', (data) => { if (data.type === 'private') { const ts = usersOnline[data.to]; if (ts) io.to(ts).emit('user_typing_broadcast', { from: sessionUser, isTyping: data.isTyping }); } });

    socket.on('req_delete_message', (data) => {
        const msgIndex = db.messages.findIndex(m => m.id === data.messageId);
        if (msgIndex !== -1) {
            const msg = db.messages[msgIndex];
            if (data.user === 'Danumala' || msg.author === data.user) { db.messages.splice(msgIndex, 1); saveDB(); io.emit('msg_deleted', data.messageId); }
        }
    });

    socket.on('disconnect', () => {
        if (sessionUser && usersOnline[sessionUser] === socket.id) {
            delete usersOnline[sessionUser];
            Object.keys(usersOnline).forEach(u => {
                const targetSocket = io.sockets.sockets.get(usersOnline[u]);
                if (targetSocket) sendActiveChatsAndFriends(targetSocket, u);
            });
        }
    });
});

server.listen(PORT, () => { console.log(`Сервер запущен на порту ${PORT}`); });
