module.exports = {
    apps: [
        {
            name: 'p2p-bot',
            script: './index.js',
            watch: false,
            autorestart: true,
            max_restarts: 10,
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};