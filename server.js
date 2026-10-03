const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');

const app = express();
app.use(cors()); 
app.use(express.json()); 
app.use(express.static(__dirname));

// 1. KẾT NỐI ĐẾN CLOUD DATABASE (MYSQL)
const pool = mysql.createPool({
    uri: process.env.DB_URI || 'mysql://2sH2hBKRZWCqXSP.root:pHbcjHbe91aD9EGf@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/test', 
    ssl: { rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 2. KHỞI TẠO BẢNG TỰ ĐỘNG
pool.query(`CREATE TABLE IF NOT EXISTS players (
    username VARCHAR(255) PRIMARY KEY,
    password VARCHAR(255),
    balance BIGINT,
    displayBalance BIGINT,
    maxWin BIGINT,
    shopData TEXT,
    adTime BIGINT DEFAULT 0,
    lionTime BIGINT DEFAULT 0,
    dolphinTime BIGINT DEFAULT 0
)`, (err) => {
    if (err) console.error("Lỗi tạo bảng MySQL:", err.message);
    else console.log("Đã kết nối Cloud MySQL Database thành công.");
});

// FIX & BỔ SUNG: Parse cấu hình avatar và khung
const parseShopData = (dataString) => {
    try { 
        let data = dataString ? JSON.parse(dataString) : {}; 
        data.unlocked = data.unlocked || [];
        data.equipped = data.equipped || 'nut-quay.png';
        data.equippedAvatar = data.equippedAvatar || 'avatar4.png';
        data.equippedFrame = data.equippedFrame || 'khunghienthi4.png';
        if (data.equipped === 'nut6.jpg' || data.equipped === 'nut6.png') data.equipped = 'spin7.mp4';
        return data;
    } 
    catch(e) { return { unlocked: [], equipped: 'nut-quay.png', equippedAvatar: 'avatar4.png', equippedFrame: 'khunghienthi4.png' }; }
};

function createPRNG(seed) {
    return function() {
        var t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

const PAYTABLE = {
  '🐸': [ {min: 15, val: 25}, {min: 12, val: 9}, {min: 10, val: 6}, {min: 8, val: 4} ], '🐗': [ {min: 15, val: 30}, {min: 12, val: 10}, {min: 10, val: 7}, {min: 8, val: 5} ],
  '🐟': [ {min: 15, val: 40}, {min: 12, val: 15}, {min: 10, val: 9}, {min: 8, val: 7} ], '🐼': [ {min: 15, val: 50}, {min: 12, val: 20}, {min: 10, val: 10}, {min: 8, val: 9} ],
  '🦅': [ {min: 15, val: 75}, {min: 12, val: 30}, {min: 10, val: 15}, {min: 8, val: 10} ], '🐘': [ {min: 15, val: 100}, {min: 12, val: 40}, {min: 10, val: 20}, {min: 8, val: 12} ],
  '🐯': [ {min: 15, val: 150}, {min: 12, val: 60}, {min: 10, val: 30}, {min: 8, val: 15} ], '🦄': [ {min: 15, val: 250}, {min: 12, val: 100}, {min: 10, val: 50}, {min: 8, val: 25} ],
  '🐲': [ {min: 15, val: 500}, {min: 12, val: 200}, {min: 10, val: 100}, {min: 8, val: 50} ], 'SCATTER': [ {min: 6, val: 20}, {min: 5, val: 10}, {min: 4, val: 4} ]
};

function getBasePayout(sym, count) { if (!PAYTABLE[sym]) return 0; for (let rule of PAYTABLE[sym]) { if (count >= rule.min) return rule.val; } return 0; }

function simulateGame(seed, bet) {
    let rng = createPRNG(seed);
    let grid = Array(6).fill(null).map(() => Array(6).fill(null));
    let unlockedCols = [false, false, false, false, false, false];
    let globalMultiplier = 0, freeSpinsLeft = 0, cumulativeTumbles = 0;

    function getRandomMultiplierValue() { const subRand = rng(); return subRand < 0.001 ? 'x100' : subRand < 0.011 ? 'x50' : subRand < 0.061 ? 'x10' : subRand < 0.161 ? 'x8' : subRand < 0.311 ? 'x5' : subRand < 0.511 ? 'x4' : subRand < 0.711 ? 'x3' : 'x2'; }
    function getRandomSymbol(inFreeSpinsMode) {
        let scatterProb = 0.025, multiProb = bet > 1000 ? 0.015 : 0.02;
        const rand = rng();
        if (rand < scatterProb) return 'SCATTER';
        if (rand < scatterProb + multiProb) return getRandomMultiplierValue();
        const symRand = rng();
        return symRand < 0.15 ? '🐸' : symRand < 0.30 ? '🐗' : symRand < 0.45 ? '🐟' : symRand < 0.59 ? '🐼' : symRand < 0.71 ? '🦅' : symRand < 0.81 ? '🐘' : symRand < 0.89 ? '🐯' : symRand < 0.95 ? '🦄' : '🐲';
    }

    function runSpin(inFreeSpinsMode) {
        if (!inFreeSpinsMode) { cumulativeTumbles = 0; unlockedCols = [false, false, false, false, false, false]; }
        for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) grid[r][c] = (r === 0 && !unlockedCols[c]) ? null : getRandomSymbol(inFreeSpinsMode);
        
        let isTumbling = true, scatterTriggeredThisSpin = false, spinBaseWinTotal = 0, spinTotalMultiplier = 0, spinFSWinTotal = 0;        

        while (isTumbling) {
            const counts = {}; let scatterCount = 0; let multCellsThisStep = [];
            for (let r = 0; r < 6; r++) {
                for (let c = 0; c < 6; c++) {
                    if (r === 0 && !unlockedCols[c]) continue;
                    const sym = grid[r][c]; if (!sym) continue;
                    if (sym === 'SCATTER') scatterCount++;
                    else if (typeof sym === 'string' && sym.startsWith('x')) multCellsThisStep.push({r, c, val: parseInt(sym.replace('x', ''))});
                    else counts[sym] = (counts[sym] || 0) + 1;
                }
            }
            if (scatterCount > 0) counts['SCATTER'] = scatterCount;
            if (scatterCount >= 4 && !inFreeSpinsMode && !scatterTriggeredThisSpin) scatterTriggeredThisSpin = true;

            const winningSymbols = Object.keys(counts).filter(sym => sym === 'SCATTER' ? counts[sym] >= 4 : counts[sym] >= 8);
            let hasAction = inFreeSpinsMode ? (winningSymbols.length > 0 || multCellsThisStep.length > 0) : (winningSymbols.length > 0);

            if (hasAction) {
                let stepWin = 0; let scatterRetriggeredThisStep = (winningSymbols.includes('SCATTER') && inFreeSpinsMode);
                if (winningSymbols.length > 0) { cumulativeTumbles++; winningSymbols.forEach(sym => stepWin += getBasePayout(sym, counts[sym]) * (bet / 10)); }
                for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) if (r !== 0 || unlockedCols[c]) if (winningSymbols.includes(grid[r][c])) grid[r][c] = null;

                if (inFreeSpinsMode) {
                    if (multCellsThisStep.length > 0) multCellsThisStep.forEach(item => { globalMultiplier += item.val; grid[item.r][item.c] = null; });
                    let currentStepFinalWin = stepWin * (globalMultiplier > 0 ? globalMultiplier : 1);
                    spinFSWinTotal += currentStepFinalWin;
                } else {
                    spinBaseWinTotal += stepWin;
                    multCellsThisStep.forEach(item => { spinTotalMultiplier += item.val; grid[item.r][item.c] = null; });
                }

                if (scatterRetriggeredThisStep) freeSpinsLeft += 5;

                const UNLOCK_THRESHOLDS = [1, 3, 6, 9, 12, 15];
                for (let i = 0; i < 6; i++) if (!unlockedCols[i] && cumulativeTumbles >= UNLOCK_THRESHOLDS[i]) unlockedCols[i] = true;

                for (let c = 0; c < 6; c++) {
                    const startRow = unlockedCols[c] ? 0 : 1;
                    for (let r = 5; r >= startRow; r--) {
                        if (grid[r][c] === null) {
                            let upperRow = r - 1;
                            while (upperRow >= startRow && grid[upperRow][c] === null) upperRow--;
                            if (upperRow >= startRow && grid[upperRow][c] !== null) { grid[r][c] = grid[upperRow][c]; grid[upperRow][c] = null; }
                        }
                    }
                }
                for (let c = 0; c < 6; c++) {
                    const startRow = unlockedCols[c] ? 0 : 1;
                    for (let r = startRow; r < 6; r++) if (grid[r][c] === null) grid[r][c] = getRandomSymbol(inFreeSpinsMode);
                }
            } else isTumbling = false; 
        }

        if (scatterTriggeredThisSpin && !inFreeSpinsMode) freeSpinsLeft += 10;
        
        if (inFreeSpinsMode) return spinFSWinTotal;
        else { let mult = spinTotalMultiplier > 0 ? spinTotalMultiplier : 1; return spinBaseWinTotal * mult; }
    }

    let totalRoundWin = runSpin(false); 
    let triggeredFSFlag = freeSpinsLeft > 0;
    
    if (triggeredFSFlag) { globalMultiplier = 0; cumulativeTumbles = 0; unlockedCols = [false, false, false, false, false, false]; }
    while(freeSpinsLeft > 0) { freeSpinsLeft--; totalRoundWin += runSpin(true); }
    return { totalWin: totalRoundWin, triggeredFS: triggeredFSFlag };
}

/* ======================================================
   API ENDPOINTS
   ====================================================== */

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Vui lòng nhập đủ tài khoản và mật khẩu." });

    pool.query(`SELECT * FROM players WHERE username = ?`, [username], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const row = rows[0];
        
        if (row) {
            if (row.password === password) {
                pool.query(`UPDATE players SET displayBalance = balance WHERE username = ?`, [username]);
                res.json({ 
                    balance: row.balance, maxWin: row.maxWin, shopData: parseShopData(row.shopData),
                    adTime: row.adTime, lionTime: row.lionTime, dolphinTime: row.dolphinTime
                });
            } else res.status(401).json({ error: "Sai mật khẩu!" });
        } else {
            const defaultShopData = JSON.stringify({ unlocked: [], equipped: 'nut-quay.png', equippedAvatar: 'avatar4.png', equippedFrame: 'khunghienthi4.png' });
            pool.query(`INSERT INTO players (username, password, balance, displayBalance, maxWin, shopData, adTime, lionTime, dolphinTime) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`, 
                [username, password, 1000, 1000, 0, defaultShopData], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ balance: 1000, maxWin: 0, shopData: parseShopData(defaultShopData), adTime: 0, lionTime: 0, dolphinTime: 0 });
            });
        }
    });
});

app.post('/spin', (req, res) => {
    const { username, password, bet } = req.body;
    const ALLOWED_BETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    if (!ALLOWED_BETS.includes(bet)) return res.status(400).json({error: "Mức cược không hợp lệ!"});

    pool.query(`UPDATE players SET balance = balance - ?, displayBalance = displayBalance - ? WHERE username = ? AND password = ? AND balance >= ?`, 
    [bet, bet, username, password, bet], (err, result) => {
        if (err) return res.status(500).json({ error: "Lỗi hệ thống!" });
        if (result.affectedRows === 0) return res.status(400).json({ error: "Không đủ Thịt hoặc sai mật khẩu!" });

        const seed = Math.floor(Math.random() * 2147483647);
        const simResult = simulateGame(seed, bet);
        const winAmount = simResult.totalWin;

        pool.query(`UPDATE players SET balance = balance + ?, maxWin = CASE WHEN ? > maxWin THEN ? ELSE maxWin END WHERE username = ?`, 
        [winAmount, winAmount, winAmount, username], () => {
            if (!simResult.triggeredFS && winAmount > 0) pool.query(`UPDATE players SET displayBalance = displayBalance + ? WHERE username = ?`, [winAmount, username]);
            pool.query(`SELECT balance, maxWin FROM players WHERE username = ?`, [username], (err, rows) => {
                res.json({ success: true, seed: seed, balance: rows[0].balance, maxWin: rows[0].maxWin, totalWin: winAmount, triggeredFS: simResult.triggeredFS });
            });
        });
    });
});

app.post('/sync_balance', (req, res) => {
    const { username, password } = req.body;
    pool.query(`UPDATE players SET displayBalance = balance WHERE username = ? AND password = ?`, [username, password], () => res.json({ success: true }));
});

app.post('/shop_buy', (req, res) => {
    const { username, password, item_id } = req.body;
    const SHOP_PRICES = { 'skin1': 10000, 'skin2': 50000, 'skin3': 500000, 'skin4': 1000000, 'skin5': 10000000, 'skin6': 100000000, 'skin7': 0, 'skin8': 1000000000, 'skin9': 2500000000, 'skin10': 2500000000 };
    const actualPrice = SHOP_PRICES[item_id];
    if (actualPrice === undefined) return res.status(400).json({error: "Vật phẩm không hợp lệ!"});

    pool.query(`SELECT shopData FROM players WHERE username = ? AND password = ?`, [username, password], (err, rows) => {
        const player = rows[0];
        if (!player) return res.status(401).json({error: "Lỗi xác thực"});
        let shopData = parseShopData(player.shopData);
        if (shopData.unlocked.includes(item_id)) return res.status(400).json({error: "Đã sở hữu vật phẩm này!"});

        pool.query(`UPDATE players SET balance = balance - ?, displayBalance = displayBalance - ? WHERE username = ? AND balance >= ?`, 
        [actualPrice, actualPrice, username, actualPrice], (err, result) => {
            if (err || result.affectedRows === 0) return res.status(400).json({error: "Tài khoản không đủ Thịt!"});
            shopData.unlocked.push(item_id);
            pool.query(`UPDATE players SET shopData = ? WHERE username = ?`, [JSON.stringify(shopData), username], () => {
                pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance, shopData: shopData }) );
            });
        });
    });
});

app.post('/shop_unlock_special', (req, res) => {
    const { username, password, item_id, code } = req.body;
    if (item_id !== 'skin7' || code !== 'Naplandau10k12345') return res.status(400).json({error: "Mã bí mật không chính xác!"});
    pool.query(`SELECT shopData FROM players WHERE username = ? AND password = ?`, [username, password], (err, rows) => {
        if (!rows[0]) return res.status(401).json({error: "Lỗi xác thực"});
        let shopData = parseShopData(rows[0].shopData);
        if (shopData.unlocked.includes(item_id)) return res.status(400).json({error: "Đã sở hữu vật phẩm này!"});
        shopData.unlocked.push(item_id);
        pool.query(`UPDATE players SET shopData = ? WHERE username = ?`, [JSON.stringify(shopData), username], () => res.json({ success: true, shopData: shopData }) );
    });
});

app.post('/shop_equip', (req, res) => {
    const { username, password, equip_src } = req.body;
    pool.query(`SELECT shopData FROM players WHERE username = ? AND password = ?`, [username, password], (err, rows) => {
        if (!rows[0]) return res.status(401).json({error: "Lỗi xác thực"});
        let shopData = parseShopData(rows[0].shopData);
        shopData.equipped = equip_src;
        pool.query(`UPDATE players SET shopData = ? WHERE username = ?`, [JSON.stringify(shopData), username], () => res.json({ success: true, shopData: shopData }) );
    });
});

// API MỚI CHO TÀI KHOẢN (TRANG BỊ AVATAR / KHUNG)
app.post('/profile_equip', (req, res) => {
    const { username, password, type, src } = req.body;
    pool.query(`SELECT shopData FROM players WHERE username = ? AND password = ?`, [username, password], (err, rows) => {
        if (!rows[0]) return res.status(401).json({error: "Lỗi xác thực"});
        let shopData = parseShopData(rows[0].shopData);
        if (type === 'avatar') shopData.equippedAvatar = src;
        else if (type === 'frame') shopData.equippedFrame = src;
        
        pool.query(`UPDATE players SET shopData = ? WHERE username = ?`, [JSON.stringify(shopData), username], () => {
            res.json({ success: true, shopData: shopData });
        });
    });
});

app.get('/top-player', (req, res) => {
    pool.query(`SELECT username, displayBalance FROM players ORDER BY displayBalance DESC LIMIT 1`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const row = rows[0];
        if (row) res.json({ username: row.username, balance: row.displayBalance });
        else res.json({ username: "Chưa có", balance: 0 });
    });
});

// API MỚI CHO BẢNG XẾP HẠNG (BXH)
app.get('/leaderboard', (req, res) => {
    const type = req.query.type;
    const orderBy = type === 'vip' ? 'maxWin' : 'displayBalance';
    
    pool.query(`SELECT username, displayBalance, maxWin, shopData FROM players ORDER BY ${orderBy} DESC LIMIT 10`, [], (err, rows) => {
        if (err) return res.status(500).json([]);
        const list = rows.map(r => {
            const shop = parseShopData(r.shopData);
            return {
                username: r.username,
                score: type === 'vip' ? r.maxWin : r.displayBalance,
                avatar: shop.equippedAvatar,
                frame: shop.equippedFrame
            };
        });
        res.json(list);
    });
});

app.post('/add_meat', (req, res) => {
    const { username, password } = req.body;
    const amount = parseInt(req.body.amount) || 0;
    if (amount <= 0 || amount > 10000000) return res.status(400).json({error: "Số lượng không hợp lệ!"});
    
    pool.query(`UPDATE players SET balance = balance + ?, displayBalance = displayBalance + ? WHERE username = ? AND password = ?`, 
    [amount, amount, username, password], (err, result) => {
        if (result.affectedRows === 0) return res.status(400).json({error: "Xác thực thất bại!"});
        pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance }) );
    });
});

app.post('/watch_ad', (req, res) => {
    const { username, password } = req.body;
    const now = Date.now();
    const cooldown = 60 * 60 * 1000; 

    pool.query(`UPDATE players SET balance = balance + 200, displayBalance = displayBalance + 200, adTime = ? WHERE username = ? AND password = ? AND (? - adTime >= ?)`, 
    [now, username, password, now, cooldown], (err, result) => {
        if (err || result.affectedRows === 0) return res.status(400).json({error: "Chưa hết thời gian chờ hoặc lỗi xác thực!"});
        pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance, adTime: now }) );
    });
});

app.post('/unlock_animal', (req, res) => {
    const { username, password, animalId } = req.body;
    let cost = 0;
    if (animalId === 'dolphin') cost = 500;
    else if (animalId === 'elephant') cost = 2000;
    else if (animalId !== 'lion') return res.status(400).json({error: "Pet không hợp lệ!"});

    if (cost > 0) {
        pool.query(`UPDATE players SET balance = balance - ?, displayBalance = displayBalance - ? WHERE username = ? AND password = ? AND balance >= ?`, 
        [cost, cost, username, password, cost], (err, result) => {
            if (result.affectedRows === 0) return res.status(400).json({error: "Không đủ Thịt hoặc lỗi!"});
            pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance }));
        });
    } else res.json({ success: true });
});

app.post('/finish_quiz', (req, res) => {
    const { username, password } = req.body;
    let ans = parseInt(req.body.correctAnswers) || 0;
    if (ans < 0 || ans > 20) return res.status(400).json({error: "Số câu hỏi bị thao túng!"}); 
    
    let multiplier = ans >= 18 ? 45 : (ans >= 12 ? 35 : (ans >= 6 ? 30 : 20));
    let meatEarned = ans * multiplier;
    const now = Date.now();
    const cooldown = 3 * 60 * 60 * 1000;

    pool.query(`UPDATE players SET balance = balance + ?, displayBalance = displayBalance + ?, lionTime = ? WHERE username = ? AND password = ? AND (? - lionTime >= ?)`, 
    [meatEarned, meatEarned, now, username, password, now, cooldown], (err, result) => {
        if (result.affectedRows === 0) return res.status(400).json({error: "Sư tử đang nghỉ ngơi!"});
        pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance, meatEarned: meatEarned, lionTime: now }) );
    });
});

app.post('/finish_dolphin', (req, res) => {
    const { username, password } = req.body;
    let dist = parseInt(req.body.distance) || 0;
    if (dist < 0 || dist > 50000) return res.status(400).json({error: "Khoảng cách bị thao túng!"});
    let meatEarned = Math.min(Math.floor(dist / 10) * 50, 10000);
    const now = Date.now();
    const cooldown = 3 * 60 * 60 * 1000;
    
    pool.query(`UPDATE players SET balance = balance + ?, displayBalance = displayBalance + ?, dolphinTime = ? WHERE username = ? AND password = ? AND (? - dolphinTime >= ?)`, 
    [meatEarned, meatEarned, now, username, password, now, cooldown], (err, result) => {
        if (result.affectedRows === 0) return res.status(400).json({error: "Cá heo đang bơi đi xa!"});
        pool.query(`SELECT balance FROM players WHERE username = ?`, [username], (err, rows) => res.json({ success: true, balance: rows[0].balance, meatEarned: meatEarned, dolphinTime: now }) );
    });
});

const PORT = 8080;
app.listen(PORT, () => {
    console.log(`[BẢO MẬT MYSQL ĐÁM MÂY] Máy chủ Game đang chạy tại: http://localhost:${PORT}`);
});