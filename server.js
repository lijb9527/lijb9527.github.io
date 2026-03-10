const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const players = {};
const rooms = {};
const deck = {
    suits: ['♠', '♥', '♦', '♣'],
    values: ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
};

function createDeck() {
    const newDeck = [];
    for (const suit of deck.suits) {
        for (const value of deck.values) {
            newDeck.push({ suit, value });
        }
    }
    return shuffleDeck(newDeck);
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function createRoom(roomId, playerId) {
    rooms[roomId] = {
        id: roomId,
        players: [],
        deck: [],
        communityCards: [],
        pot: 0,
        currentBet: 0,
        currentPlayerIndex: 0,
        dealerIndex: 0,
        phase: 'waiting',
        smallBlind: 10,
        bigBlind: 20
    };
    joinRoom(roomId, playerId);
}

function joinRoom(roomId, playerId) {
    const room = rooms[roomId];
    if (room.players.length >= 8) return false;
    
    room.players.push({
        id: playerId,
        name: players[playerId].name,
        chips: 1000,
        cards: [],
        currentBet: 0,
        folded: false,
        allIn: false
    });
    
    players[playerId].roomId = roomId;
    return true;
}

function dealCards(roomId) {
    const room = rooms[roomId];
    room.deck = createDeck();
    room.communityCards = [];
    room.pot = 0;
    room.currentBet = 0;
    room.phase = 'preflop';
    
    room.players.forEach(player => {
        player.cards = [room.deck.pop(), room.deck.pop()];
        player.currentBet = 0;
        player.folded = false;
        player.allIn = false;
    });
    
    postBlinds(roomId);
}

function postBlinds(roomId) {
    const room = rooms[roomId];
    const smallBlindIndex = (room.dealerIndex + 1) % room.players.length;
    const bigBlindIndex = (room.dealerIndex + 2) % room.players.length;
    
    const smallBlindPlayer = room.players[smallBlindIndex];
    const bigBlindPlayer = room.players[bigBlindIndex];
    
    smallBlindPlayer.chips -= room.smallBlind;
    smallBlindPlayer.currentBet = room.smallBlind;
    bigBlindPlayer.chips -= room.bigBlind;
    bigBlindPlayer.currentBet = room.bigBlind;
    
    room.pot = room.smallBlind + room.bigBlind;
    room.currentBet = room.bigBlind;
    room.currentPlayerIndex = (bigBlindIndex + 1) % room.players.length;
}

function nextPhase(roomId) {
    const room = rooms[roomId];
    const activePlayers = room.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        endRound(roomId, activePlayers[0]);
        return;
    }
    
    room.players.forEach(p => p.currentBet = 0);
    room.currentBet = 0;
    room.currentPlayerIndex = (room.dealerIndex + 1) % room.players.length;
    
    switch (room.phase) {
        case 'preflop':
            room.phase = 'flop';
            room.communityCards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
            break;
        case 'flop':
            room.phase = 'turn';
            room.communityCards.push(room.deck.pop());
            break;
        case 'turn':
            room.phase = 'river';
            room.communityCards.push(room.deck.pop());
            break;
        case 'river':
            evaluateWinner(roomId);
            return;
    }
}

function evaluateWinner(roomId) {
    const room = rooms[roomId];
    const activePlayers = room.players.filter(p => !p.folded);
    
    let bestHand = null;
    let winners = [];
    
    activePlayers.forEach(player => {
        const hand = evaluateHand(player.cards, room.communityCards);
        if (!bestHand || compareHands(hand, bestHand) > 0) {
            bestHand = hand;
            winners = [player];
        } else if (compareHands(hand, bestHand) === 0) {
            winners.push(player);
        }
    });
    
    endRound(roomId, winners);
}

function evaluateHand(holeCards, communityCards) {
    const allCards = [...holeCards, ...communityCards];
    const combinations = getCombinations(allCards, 5);
    
    let bestHand = null;
    
    for (const combo of combinations) {
        const hand = getHandRank(combo);
        if (!bestHand || compareHands(hand, bestHand) > 0) {
            bestHand = hand;
        }
    }
    
    return bestHand;
}

function getCombinations(arr, size) {
    const result = [];
    
    function combine(start, combo) {
        if (combo.length === size) {
            result.push([...combo]);
            return;
        }
        
        for (let i = start; i < arr.length; i++) {
            combo.push(arr[i]);
            combine(i + 1, combo);
            combo.pop();
        }
    }
    
    combine(0, []);
    return result;
}

function getHandRank(cards) {
    const values = cards.map(c => deck.values.indexOf(c.value)).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);
    
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    
    let rank = 0;
    let rankValues = values;
    
    if (isFlush && isStraight) {
        if (values[0] === 12 && values[4] === 8) {
            rank = 9;
            rankValues = [8];
        } else {
            rank = 8;
        }
    } else if (counts[0] === 4) {
        rank = 7;
        rankValues = sortFourOfAKind(values, valueCounts);
    } else if (counts[0] === 3 && counts[1] === 2) {
        rank = 6;
        rankValues = sortFullHouse(values, valueCounts);
    } else if (isFlush) {
        rank = 5;
    } else if (isStraight) {
        rank = 4;
    } else if (counts[0] === 3) {
        rank = 3;
        rankValues = sortThreeOfAKind(values, valueCounts);
    } else if (counts[0] === 2 && counts[1] === 2) {
        rank = 2;
        rankValues = sortTwoPair(values, valueCounts);
    } else if (counts[0] === 2) {
        rank = 1;
        rankValues = sortOnePair(values, valueCounts);
    }
    
    return { rank, values: rankValues, cards };
}

function checkStraight(values) {
    if (values[0] - values[4] === 4) return true;
    if (values[0] === 12 && values[1] === 3 && values[2] === 2 && values[3] === 1 && values[4] === 0) return true;
    return false;
}

function sortFourOfAKind(values, valueCounts) {
    const quad = Object.keys(valueCounts).find(k => valueCounts[k] === 4);
    const kicker = Object.keys(valueCounts).find(k => valueCounts[k] === 1);
    return [parseInt(quad), parseInt(kicker)];
}

function sortFullHouse(values, valueCounts) {
    const three = Object.keys(valueCounts).find(k => valueCounts[k] === 3);
    const pair = Object.keys(valueCounts).find(k => valueCounts[k] === 2);
    return [parseInt(three), parseInt(pair)];
}

function sortThreeOfAKind(values, valueCounts) {
    const three = Object.keys(valueCounts).find(k => valueCounts[k] === 3);
    const kickers = Object.keys(valueCounts).filter(k => valueCounts[k] === 1).map(Number).sort((a, b) => b - a);
    return [parseInt(three), ...kickers];
}

function sortTwoPair(values, valueCounts) {
    const pairs = Object.keys(valueCounts).filter(k => valueCounts[k] === 2).map(Number).sort((a, b) => b - a);
    const kicker = Object.keys(valueCounts).find(k => valueCounts[k] === 1);
    return [...pairs, parseInt(kicker)];
}

function sortOnePair(values, valueCounts) {
    const pair = Object.keys(valueCounts).find(k => valueCounts[k] === 2);
    const kickers = Object.keys(valueCounts).filter(k => valueCounts[k] === 1).map(Number).sort((a, b) => b - a);
    return [parseInt(pair), ...kickers];
}

function compareHands(hand1, hand2) {
    if (hand1.rank !== hand2.rank) return hand1.rank - hand2.rank;
    for (let i = 0; i < hand1.values.length; i++) {
        if (hand1.values[i] !== hand2.values[i]) return hand1.values[i] - hand2.values[i];
    }
    return 0;
}

function endRound(roomId, winners) {
    const room = rooms[roomId];
    const winAmount = Math.floor(room.pot / winners.length);
    
    winners.forEach(w => {
        w.chips += winAmount;
    });
    
    room.phase = 'ended';
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    
    io.to(roomId).emit('roundEnded', {
        winners: winners.map(w => ({ id: w.id, name: w.name, chips: w.chips })),
        pot: room.pot
    });
}

function nextPlayer(roomId) {
    const room = rooms[roomId];
    let nextIndex = (room.currentPlayerIndex + 1) % room.players.length;
    let checked = 0;
    
    while (checked < room.players.length) {
        const player = room.players[nextIndex];
        if (!player.folded && !player.allIn && player.chips > 0) {
            room.currentPlayerIndex = nextIndex;
            return;
        }
        nextIndex = (nextIndex + 1) % room.players.length;
        checked++;
    }
    
    const activePlayers = room.players.filter(p => !p.folded && !p.allIn);
    if (activePlayers.length <= 1) {
        nextPhase(roomId);
    } else {
        if (allBetsEqual(room)) {
            nextPhase(roomId);
        } else {
            room.currentPlayerIndex = room.players.findIndex(p => !p.folded && !p.allIn);
        }
    }
}

function allBetsEqual(room) {
    const activePlayers = room.players.filter(p => !p.folded && !p.allIn);
    return activePlayers.every(p => p.currentBet === room.currentBet || p.chips === 0);
}

function fold(roomId, playerId) {
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    player.folded = true;
    
    const activePlayers = room.players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
        endRound(roomId, activePlayers[0]);
        return;
    }
    
    nextPlayer(roomId);
}

function check(roomId, playerId) {
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    
    if (player.currentBet !== room.currentBet && player.chips > 0) return;
    
    nextPlayer(roomId);
    
    if (allBetsEqual(room)) {
        nextPhase(roomId);
    }
}

function call(roomId, playerId) {
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    
    const callAmount = Math.min(room.currentBet - player.currentBet, player.chips);
    player.chips -= callAmount;
    player.currentBet += callAmount;
    room.pot += callAmount;
    
    if (player.chips === 0) player.allIn = true;
    
    nextPlayer(roomId);
    
    if (allBetsEqual(room)) {
        nextPhase(roomId);
    }
}

function raise(roomId, playerId, amount) {
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    
    const totalBet = room.currentBet + amount;
    const betAmount = Math.min(totalBet - player.currentBet, player.chips);
    
    player.chips -= betAmount;
    player.currentBet += betAmount;
    room.pot += betAmount;
    room.currentBet = player.currentBet;
    
    if (player.chips === 0) player.allIn = true;
    
    nextPlayer(roomId);
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    socket.on('joinGame', (name) => {
        players[socket.id] = {
            id: socket.id,
            name: name || `Player${Object.keys(players).length + 1}`,
            roomId: null
        };
        
        const availableRooms = Object.values(rooms).filter(r => r.players.length < 8);
        if (availableRooms.length > 0) {
            const room = availableRooms[0];
            if (joinRoom(room.id, socket.id)) {
                socket.join(room.id);
                socket.emit('joinedRoom', { roomId: room.id, playerId: socket.id });
                io.to(room.id).emit('roomUpdate', getRoomData(room.id));
            }
        } else {
            const roomId = `room${Date.now()}`;
            createRoom(roomId, socket.id);
            socket.join(roomId);
            socket.emit('joinedRoom', { roomId, playerId: socket.id });
            io.to(roomId).emit('roomUpdate', getRoomData(roomId));
        }
    });
    
    socket.on('createRoom', () => {
        const roomId = `room${Date.now()}`;
        createRoom(roomId, socket.id);
        socket.join(roomId);
        socket.emit('joinedRoom', { roomId, playerId: socket.id });
        io.to(roomId).emit('roomUpdate', getRoomData(roomId));
    });
    
    socket.on('joinSpecificRoom', (roomId) => {
        if (!rooms[roomId]) {
            socket.emit('error', 'Room not found');
            return;
        }
        
        if (joinRoom(roomId, socket.id)) {
            socket.join(roomId);
            socket.emit('joinedRoom', { roomId, playerId: socket.id });
            io.to(roomId).emit('roomUpdate', getRoomData(roomId));
        } else {
            socket.emit('error', 'Room is full');
        }
    });
    
    socket.on('startGame', () => {
        const roomId = players[socket.id]?.roomId;
        if (!roomId) return;
        
        const room = rooms[roomId];
        if (room.players.length < 2) {
            socket.emit('error', 'At least 2 players needed');
            return;
        }
        
        dealCards(roomId);
        io.to(roomId).emit('gameUpdate', getRoomData(roomId));
    });
    
    socket.on('playerAction', (action) => {
        const roomId = players[socket.id]?.roomId;
        if (!roomId) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.currentPlayerIndex !== room.players.indexOf(player)) {
            socket.emit('error', 'Not your turn');
            return;
        }
        
        switch (action.type) {
            case 'fold':
                fold(roomId, socket.id);
                break;
            case 'check':
                check(roomId, socket.id);
                break;
            case 'call':
                call(roomId, socket.id);
                break;
            case 'raise':
                raise(roomId, socket.id, action.amount);
                break;
        }
        
        io.to(roomId).emit('gameUpdate', getRoomData(roomId));
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const roomId = players[socket.id]?.roomId;
        
        if (roomId && rooms[roomId]) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('roomUpdate', getRoomData(roomId));
            }
        }
        
        delete players[socket.id];
    });
});

function getRoomData(roomId) {
    const room = rooms[roomId];
    return {
        id: room.id,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            chips: p.chips,
            cards: p.cards,
            currentBet: p.currentBet,
            folded: p.folded,
            allIn: p.allIn
        })),
        communityCards: room.communityCards,
        pot: room.pot,
        currentBet: room.currentBet,
        currentPlayerIndex: room.currentPlayerIndex,
        dealerIndex: room.dealerIndex,
        phase: room.phase,
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Texas Hold'em server running on port ${PORT}`);
});
