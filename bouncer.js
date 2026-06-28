// bouncer.js — JS/WASM glue for Pascal Bouncer
// Loads the compiled WASM module and bridges to the browser canvas

(async () => {
    "use strict";

    let wasmModule = null;
    let wasmMemory = null;
    let wasmBuffer = null;
    let canvas = null;
    let ctx = null;
    let animationFrameId = null;
    let lastTime = performance.now();
    let keepRunning = false;

    // Scoreboard elements
    const scoreVal = document.getElementById('score-val');
    const areaVal = document.getElementById('area-val');
    const livesVal = document.getElementById('lives-val');
    const levelVal = document.getElementById('level-val');
    const finalScoreVal = document.getElementById('final-score-val');
    const nextLevelVal = document.getElementById('next-level-val');

    // Overlay elements
    const startScreen = document.getElementById('start-screen');
    const gameOverScreen = document.getElementById('game-over-screen');
    const levelCompleteScreen = document.getElementById('level-complete-screen');

    // Game states (matching Pascal TGameStatus enum)
    const StartScreen = 0;
    const Playing = 1;
    const GameOver = 2;
    const LevelUpDelay = 3;

    // WASM exports
    let exports = null;
    let fnInit = null;
    let fnRender = null;
    let fnGetWidth = null;
    let fnGetHeight = null;
    let fnGetPixels = null;
    let fnGetScore = null;
    let fnGetLives = null;
    let fnGetLevel = null;
    let fnGetGameStatus = null;
    let fnGetPercentCaptured = null;
    let fnOnStart = null;
    let fnOnKeyDown = null;
    let fnStep = null;
    let fnCanvasInit = null;

    // Canvas dimensions & pixel buffer cache
    let gameWidth = 0;
    let gameHeight = 0;
    let pixelsPtr = 0;
    let cachedImageData = null;
    let cachedPixelView = null;

    function getExport(name) {
        if (!exports) throw new Error(`WASM exports not loaded`);
        const fn = exports[name];
        if (!fn) throw new Error(`Export '${name}' not found in WASM module`);
        return fn;
    }

    // Read a string from WASM memory (null-terminated)
    function readString(ptr) {
        const bytes = [];
        let i = 0;
        while (true) {
            const byte = wasmBuffer[ptr + i];
            if (byte === 0) break;
            bytes.push(byte);
            i++;
        }
        return String.fromCharCode(...bytes);
    }

    // Read an integer (32-bit signed) from WASM memory
    function readInt32(ptr) {
        return new Int32Array(wasmMemory.buffer, ptr, 1)[0];
    }

    // Read a float (64-bit) from WASM memory
    function readFloat64(ptr) {
        return new Float64Array(wasmMemory.buffer, ptr, 1)[0];
    }

    // Write a string to WASM memory (caller must allocate enough space)
    function writeString(str, ptr) {
        for (let i = 0; i < str.length; i++) {
            wasmBuffer[ptr + i] = str.charCodeAt(i);
        }
        wasmBuffer[ptr + str.length] = 0;
    }

    // Helper to read a Pascal string from a pointer
    function readPascalString(ptr) {
        // Pascal string: first byte is length, then characters
        const len = wasmBuffer[ptr];
        const chars = [];
        for (let i = 0; i < len; i++) {
            chars.push(wasmBuffer[ptr + 1 + i]);
        }
        return String.fromCharCode(...chars);
    }

    // Tell Pascal where to draw — fixed offset past all static data
    function setupCanvas() {
        gameWidth = canvas.width;
        gameHeight = canvas.height;
        // Use a fixed safe offset (256 KB = 0x40000), well past static
        // data segments which end around 104 KB.  1200*750*4 = 3.6 MB
        // fits comfortably in the 4 MB initial memory.
        pixelsPtr = 256 * 1024;
        if (fnCanvasInit) {
            fnCanvasInit(gameWidth, gameHeight, pixelsPtr, 0);
        }

        // Pre-allocate the ImageData buffer and typed array view
        if (ctx) {
            cachedImageData = ctx.createImageData(gameWidth, gameHeight);
            cachedPixelView = new Uint8ClampedArray(wasmMemory.buffer, pixelsPtr, gameWidth * gameHeight * 4);
        }

        return pixelsPtr;
    }

    // Initialize the WASM module
    async function initWasm() {
        const response = await fetch('bouncer.wasm');
        const buffer = await response.arrayBuffer();

        // Provide _haltproc import required by FPC embedded target
        const importObject = {
            env: {
                _haltproc: (exitCode) => {
                    console.log(`Pascal halted with code: ${exitCode}`);
                    keepRunning = false;
                }
            }
        };

        wasmModule = await WebAssembly.instantiate(buffer, importObject);
        wasmMemory = wasmModule.instance.exports.memory;
        wasmBuffer = new Uint8Array(wasmMemory.buffer);
        exports = wasmModule.instance.exports;

        // Resolve and cache WASM exports
        fnInit = getExport('init');
        fnRender = getExport('render');
        fnGetWidth = getExport('get_width');
        fnGetHeight = getExport('get_height');
        fnGetPixels = getExport('get_pixels');
        fnGetScore = getExport('get_score');
        fnGetLives = getExport('get_lives');
        fnGetLevel = getExport('get_level');
        fnGetGameStatus = getExport('get_game_status');
        fnGetPercentCaptured = getExport('get_percent_captured');
        fnOnStart = getExport('on_start');
        fnOnKeyDown = getExport('on_key_down');
        fnStep = getExport('step');
        fnCanvasInit = getExport('CanvasInit');

        // Call Pascal's init
        if (fnInit) {
            fnInit();
        }
    }

    // Render the game frame
    function render() {
        if (fnRender) {
            fnRender();
        }

        // Copy the pixel buffer to the canvas
        if (canvas && ctx && cachedImageData && cachedPixelView) {
            // Safety check: If WASM memory grows, the buffer becomes detached.
            if (cachedPixelView.buffer.byteLength === 0) {
                cachedPixelView = new Uint8ClampedArray(wasmMemory.buffer, pixelsPtr, gameWidth * gameHeight * 4);
            }
            cachedImageData.data.set(cachedPixelView);
            ctx.putImageData(cachedImageData, 0, 0);
        }
    }

    // Update the scoreboard UI
    function updateUI() {
        if (!fnGetScore || !fnGetLives || !fnGetLevel || !fnGetGameStatus || !fnGetPercentCaptured) return;

        const score = fnGetScore();
        const lives = fnGetLives();
        const level = fnGetLevel();
        const status = fnGetGameStatus();
        const percent = fnGetPercentCaptured();

        scoreVal.textContent = String(score).padStart(6, '0');
        areaVal.textContent = percent.toFixed(1) + '%';
        livesVal.textContent = lives;
        levelVal.textContent = level;

        // Handle overlays
        switch (status) {
            case StartScreen:
                startScreen.classList.remove('hidden');
                gameOverScreen.classList.add('hidden');
                levelCompleteScreen.classList.add('hidden');
                break;
            case Playing:
                startScreen.classList.add('hidden');
                gameOverScreen.classList.add('hidden');
                levelCompleteScreen.classList.add('hidden');
                break;
            case GameOver:
                startScreen.classList.add('hidden');
                gameOverScreen.classList.remove('hidden');
                levelCompleteScreen.classList.add('hidden');
                finalScoreVal.textContent = score;
                break;
            case LevelUpDelay:
                startScreen.classList.add('hidden');
                gameOverScreen.classList.add('hidden');
                levelCompleteScreen.classList.remove('hidden');
                nextLevelVal.textContent = level + 1;
                break;
        }
    }

    // Handle key events
    function handleKeyDown(e) {
        const key = e.keyCode || e.which;

        // Enter/Space to start/restart — works even when game loop isn't running yet
        if (key === 13 || key === 32) {
            e.preventDefault();
            if (fnGetGameStatus && fnOnStart) {
                const status = fnGetGameStatus();
                if (status === StartScreen || status === GameOver) {
                    fnOnStart();
                    keepRunning = true;
                    lastTime = performance.now();
                    animationFrameId = requestAnimationFrame(tick);
                }
            }
            return;
        }

        // Arrow keys for player movement — only during gameplay
        if (!keepRunning) return;
        if (key >= 37 && key <= 40) {
            e.preventDefault();
            if (fnOnKeyDown) {
                fnOnKeyDown(key);
            }
        }
    }

    // Game loop
    function tick() {
        const now = performance.now();
        const deltaTime = (now - lastTime) / 1000.0; // seconds
        lastTime = now;

        // Call Pascal's step function (expects seconds)
        if (fnStep) {
            fnStep(deltaTime);
        }

        // Render the frame
        render();

        // Update UI
        updateUI();

        if (keepRunning) {
            animationFrameId = requestAnimationFrame(tick);
        } else {
            animationFrameId = null;
        }
    }

    // Initialize everything
    async function init() {
        try {
            await initWasm();

            // Get canvas element
            canvas = document.getElementById('game-canvas');
            ctx = canvas.getContext('2d');

            // Tell Pascal about the canvas pixel buffer
            setupCanvas();

            // Set up event listeners
            window.addEventListener('keydown', handleKeyDown);

            // Start button
            document.getElementById('start-button').addEventListener('click', () => {
                if (fnGetGameStatus && fnOnStart) {
                    const status = fnGetGameStatus();
                    if (status === StartScreen || status === GameOver) {
                        fnOnStart();
                        keepRunning = true;
                        lastTime = performance.now();
                        animationFrameId = requestAnimationFrame(tick);
                    }
                }
            });

            // Restart button
            document.getElementById('restart-button').addEventListener('click', () => {
                if (fnOnStart) {
                    fnOnStart();
                    keepRunning = true;
                    lastTime = performance.now();
                    animationFrameId = requestAnimationFrame(tick);
                }
            });

            // Initial render
            updateUI();

        } catch (e) {
            console.error('Failed to initialize WASM:', e);
        }
    }

    // Start the game
    init();
})();
