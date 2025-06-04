// WebRTC Streaming Server
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const connections = new Map();
let streamerConnectionId = null;
const clientNicks = new Map();

const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        const htmlPath = path.join(__dirname, 'webrtc_serve.html');
        fs.readFile(htmlPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

httpServer.listen(PORT, () => {
    console.log(`HTTP Server listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log('Open the same URL in another browser/tab to view the stream.');
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
    const connectionId = generateUniqueId();
    connections.set(connectionId, ws);
    clientNicks.set(connectionId, '');
    console.log(`Client connected with ID: ${connectionId}. Total connections: ${connections.size}`);

    ws.send(JSON.stringify({ type: 'id', id: connectionId }));

    if(streamerConnectionId) {
        ws.send(JSON.stringify({ type: 'streamerAvailable' }));
    }

    function broadcastViewerCount() {
        let count = 0;
        connections.forEach((clientWs, id) => {
            if (id !== streamerConnectionId) count++;
        });
        connections.forEach((clientWs) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'viewerCount', count }));
            }
        });
    }

    function broadcastUserEvent(type, id) {
        const nick = clientNicks.get(id) || id;
        connections.forEach((clientWs) => {
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type, id, nick }));
            }
        });
    }

    broadcastUserEvent('userJoined', connectionId);
    broadcastViewerCount();

    ws.on('message', (message) => {
        console.log(`Received message from ${connectionId}: ${message}`);
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'setType':
                    const role = data.role;
                    
                    if (data.nick && typeof data.nick === 'string') {
                        clientNicks.set(connectionId, data.nick);
                        broadcastViewerCount();
                    }
                    if (role === 'streamer') {
                        if (streamerConnectionId === null) {
                            streamerConnectionId = connectionId;
                            console.log(`${connectionId} is now the streamer.`);
                            connections.forEach((clientWs, id) => {
                                if (id !== connectionId && clientWs.readyState === WebSocket.OPEN) {
                                    clientWs.send(JSON.stringify({ type: 'streamerAvailable' }));
                                }
                            });

                        } else {
                            console.warn(`${connectionId} tried to become streamer, but ${streamerConnectionId} is already streaming.`);
                        }
                    } else if (role === 'viewer') {
                        console.log(`${connectionId} is a viewer.`);
                        if (streamerConnectionId && connections.has(streamerConnectionId)) {
                              console.log(`Notifying streamer (${streamerConnectionId}) about new viewer ${connectionId}`);
                             connections.get(streamerConnectionId).send(JSON.stringify({
                                 type: 'newViewer',
                                 viewerId: connectionId
                             }));
                         } else {
                             console.log(`Viewer ${connectionId} connected, but no streamer is available.`);
                             ws.send(JSON.stringify({ type: 'streamerUnavailable' }));
                         }
                    }
                    break;

                case 'offer':
                    if (connectionId === streamerConnectionId && data.to) {
                        const viewerWs = connections.get(data.to);
                        if (viewerWs && viewerWs.readyState === WebSocket.OPEN) {
                            console.log(`Routing offer from ${connectionId} to ${data.to}`);
                            viewerWs.send(JSON.stringify(data));
                        } else {
                            console.warn(`Viewer ${data.to} not found or not open for offer from ${connectionId}`);
                        }
                    } else {
                        console.warn(`Received offer from non-streamer or without 'to': ${connectionId}`);
                    }
                    break;

                case 'answer':
                    if (data.to === streamerConnectionId && data.from) {
                         const streamerWs = connections.get(streamerConnectionId);
                         if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
                             console.log(`Routing answer from ${connectionId} to ${data.to}`);
                             streamerWs.send(JSON.stringify(data));
                         } else {
                             console.warn(`Streamer ${data.to} not found or not open for answer from ${connectionId}`);
                         }
                    } else {
                         console.warn(`Received answer not addressed to streamer or missing 'from': ${connectionId}`);
                    }
                    break;

                case 'icecandidate':
                    if (data.to && data.from) {
                         const otherPeerWs = connections.get(data.to);
                         if (otherPeerWs && otherPeerWs.readyState === WebSocket.OPEN) {
                             console.log(`Routing ICE candidate from ${connectionId} to ${data.to}`);
                             const forwardedData = { ...data, from: connectionId };
                             otherPeerWs.send(JSON.stringify(forwardedData));
                         } else {
                             console.warn(`Other peer ${data.to} not found or not open for ICE candidate from ${connectionId}`);
                         }
                    } else {
                         console.warn(`Received ICE candidate without 'to' or 'from': ${connectionId}`);
                    }
                    break;

                case 'checkStreamer':
                     if (streamerConnectionId) {
                         ws.send(JSON.stringify({ type: 'streamerAvailable' }));
                     } else {
                         ws.send(JSON.stringify({ type: 'streamerUnavailable' }));
                     }
                    break;

                case 'chat':
                    const nick = clientNicks.get(connectionId) || data.nick || connectionId;
                    connections.forEach((clientWs) => {
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'chat',
                                from: data.from,
                                text: data.text,
                                nick
                            }));
                        }
                    });
                    break;

                default:
                    console.warn(`Unhandled message type from ${connectionId}: ${data.type}`);
            }

        } catch (e) {
            console.error(`Error parsing message from ${connectionId}: ${e}`);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected with ID: ${connectionId}. Total connections: ${connections.size - 1}`);
        connections.delete(connectionId);
        broadcastUserEvent('userLeft', connectionId);
        clientNicks.delete(connectionId);

        if (streamerConnectionId === connectionId) {
            console.log('Streamer disconnected.');
            streamerConnectionId = null;
            connections.forEach((clientWs) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                     clientWs.send(JSON.stringify({ type: 'streamerUnavailable' }));
                }
            });
        }
    });

    ws.onerror = (error) => {
        console.error(`WebSocket error for client ${connectionId}:`, error);
    };
});

function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

console.log('NodeJS WebRTC strimek running...');
