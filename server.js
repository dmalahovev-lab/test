const express = require('express');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Буфер обмена данными между активными вкладками
let globalState = {
    users: [],
    messages: []
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Синхронизация локальной базы с сервером
app.post('/api/sync', (req, res) => {
    if (req.body.users) {
        req.body.users.forEach(u => {
            if (!globalState.users.some(existing => existing.name === u.name)) {
                globalState.users.push(u);
            }
        });
    }
    if (req.body.messages) {
        globalState.messages = req.body.messages;
    }
    res.json(globalState);
});

app.post('/api/register', (req, res) => {
    const username = (req.body.user || '').trim();
    const password = (req.body.pass || '').trim();

    if (!username || !password) {
        return res.json({ success: false, msg: 'Заполните все поля' });
    }

    if (globalState.users.some(u => u.name === username)) {
        return res.json({ success: false, msg: 'Пользователь уже существует' });
    }

    const newUser = { name: username, password: password, avatar: "🤖", status: "Доступен" };
    globalState.users.push(newUser);

    return res.json({ success: true, msg: 'Аккаунт успешно создан! Нажмите "Войти"', newUser });
});

app.post('/api/login', (req, res) => {
    const username = (req.body.user || '').trim();
    const password = (req.body.pass || '').trim();

    // Авто-восстановление аккаунта в памяти сервера, если он есть у клиента локально
    let user = globalState.users.find(u => u.name === username);
    if (!user) {
        user = { name: username, password: password, avatar: "🤖", status: "Доступен" };
        globalState.users.push(user);
    }

    if (user.password !== password) {
        return res.json({ success: false, msg: 'Недействительный Логин/Пароль' });
    }

    return res.json({
        success: true,
        user: { name: username, avatar: user.avatar, status: user.status }
    });
});

app.get('/api/users', (req, res) => {
    res.json(globalState.users);
});

app.get('/api/messages', (req, res) => {
    res.json(globalState.messages);
});

app.post('/api/messages/send', (req, res) => {
    const newMsg = {
        id: Date.now().toString(),
        from: req.body.from,
        to: req.body.to,
        text: req.body.text
    };
    globalState.messages.push(newMsg);
    res.json({ success: true, messages: globalState.messages });
});

app.post('/api/messages/delete', (req, res) => {
    globalState.messages = globalState.messages.filter(msg => msg.id !== req.body.msgId);
    res.json({ success: true, messages: globalState.messages });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер DanuMes запущен на порту ${PORT}`);
});
