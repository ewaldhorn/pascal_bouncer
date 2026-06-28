// bouncer.js — JS/WASM glue for Pascal Bouncer
// Loads the compiled WASM module and bridges to the browser canvas

(async () => {
    "use strict";

    let wasmInstance = null;
    let wasmMemory = null;
    let wasmBuffer = null;  // Uint8Array view — refreshed on WASM memory growth
    let wasmView = null;    // DataView — refreshed on WASM memory growth
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

    // WASM exports — populated once in initWasm(); never null after that
    let fnInit = null;
    let fnRender = null;
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

    // UI state caching to prevent redundant DOM updates
    let lastScore = null;
    let lastLives = null;
    let lastLevel = null;
    let lastStatus = null;
    let lastPercent = null;

    function getExport(exports, name) {
        const fn = exports[name];
        if (!fn) throw new Error(`Export '${name}' not found in WASM module`);
        return fn;
    }

    function requireDom(id) {
        const el = document.getElementById(id);
        if (!el) throw new Error(`DOM element #${id} not found in the page`);
        return el;
    }

    // ---------------------------------------------------------------------------
    // WASM memory helpers — not used by the current game loop but kept here for
    // future Pascal↔JS data exchange (e.g. reading game strings or structs).
    // ---------------------------------------------------------------------------

    // Read a null-terminated C string from WASM memory
    // function readString(ptr) {
    //     let end = ptr;
    //     while (wasmBuffer[end] !== 0) end++;
    //     return new TextDecoder().decode(wasmBuffer.subarray(ptr, end));
    // }

    // Read a 32-bit signed integer from WASM memory (little-endian)
    // function readInt32(ptr) {
    //     return wasmView.getInt32(ptr, true);
    // }

    // Read a 64-bit float from WASM memory (little-endian)
    // function readFloat64(ptr) {
    //     return wasmView.getFloat64(ptr, true);
    // }

    // Write a null-terminated C string to WASM memory (caller must pre-allocate)
    // function writeString(str, ptr) {
    //     for (let i = 0; i < str.length; i++) {
    //         wasmBuffer[ptr + i] = str.charCodeAt(i);
    //     }
    //     wasmBuffer[ptr + str.length] = 0;
    // }

    // Read a Pascal short-string from WASM memory (length-prefixed)
    // function readPascalString(ptr) {
    //     const len = wasmBuffer[ptr];
    //     return new TextDecoder().decode(wasmBuffer.subarray(ptr + 1, ptr + 1 + len));
    // }

    // Refresh typed-array views after WASM memory growth
    function refreshMemoryViews() {
        wasmBuffer = new Uint8Array(wasmMemory.buffer);
        wasmView = new DataView(wasmMemory.buffer);
    }

    // Tell Pascal where to draw — fixed offset past all static data.
    //
    // Pixel buffer layout
    // -------------------
    // The WASM module's static data (globals, string literals, BSS) ends around
    // 104 KB.  We reserve the first 256 KB (0x00000–0x3FFFF) as a safe no-touch
    // zone, then hand Pascal a contiguous RGBA pixel buffer starting at 0x40000.
    //
    // At 1200×750 the buffer is 1200 × 750 × 4 = 3,600,000 bytes (~3.4 MB).
    // WASM initial memory is 4 MB, so the buffer fits with ~140 KB to spare.
    //
    // Ideally the Pascal side would export `get_pixels_ptr` so JS doesn't need to
    // hard-code this offset — consider adding that export in a future revision.
    function setupCanvas() {
        gameWidth = canvas.width;
        gameHeight = canvas.height;
        pixelsPtr = 256 * 1024; // 0x40000 — see layout note above
        fnCanvasInit(gameWidth, gameHeight, pixelsPtr, 0);

        // Wrap WASM memory directly — zero-copy path to putImageData
        cachedPixelView = new Uint8ClampedArray(wasmMemory.buffer, pixelsPtr, gameWidth * gameHeight * 4);
        cachedImageData = new ImageData(cachedPixelView, gameWidth, gameHeight);

        return pixelsPtr;
    }

    // Initialize the WASM module
    async function initWasm() {
        // instantiateStreaming compiles while downloading — faster & uses less memory
        // than fetching into an ArrayBuffer first.
        const importObject = {
            env: {
                _haltproc: (exitCode) => {
                    console.log(`Pascal halted with code: ${exitCode}`);
                    keepRunning = false;
                }
            }
        };

        const result = await WebAssembly.instantiateStreaming(fetch('bouncer.wasm'), importObject);
        wasmInstance = result.instance;
        wasmMemory = wasmInstance.exports.memory;
        refreshMemoryViews();

        const exp = wasmInstance.exports;

        // Resolve and cache all WASM exports (throws immediately if any are missing)
        fnInit = getExport(exp, 'init');
        fnRender = getExport(exp, 'render');
        getExport(exp, 'get_width');   // Validated but not stored (unused after setup)
        getExport(exp, 'get_height');
        getExport(exp, 'get_pixels');
        fnGetScore = getExport(exp, 'get_score');
        fnGetLives = getExport(exp, 'get_lives');
        fnGetLevel = getExport(exp, 'get_level');
        fnGetGameStatus = getExport(exp, 'get_game_status');
        fnGetPercentCaptured = getExport(exp, 'get_percent_captured');
        fnOnStart = getExport(exp, 'on_start');
        fnOnKeyDown = getExport(exp, 'on_key_down');
        fnStep = getExport(exp, 'step');
        fnCanvasInit = getExport(exp, 'CanvasInit');

        fnInit();
    }

    // Render the game frame
    function render() {
        fnRender();

        // Safety check: WASM memory can grow, which detaches the underlying ArrayBuffer.
        // byteLength becomes 0 on a detached buffer — much cheaper than try/catch.
        if (cachedPixelView.buffer.byteLength === 0) {
            refreshMemoryViews();
            cachedPixelView = new Uint8ClampedArray(wasmMemory.buffer, pixelsPtr, gameWidth * gameHeight * 4);
            cachedImageData = new ImageData(cachedPixelView, gameWidth, gameHeight);
        }

        ctx.putImageData(cachedImageData, 0, 0);
    }

    // Update the scoreboard UI — called every frame but DOM writes are gated on actual changes
    function updateUI() {
        const score   = fnGetScore();
        const lives   = fnGetLives();
        const level   = fnGetLevel();
        const status  = fnGetGameStatus();
        const percent = fnGetPercentCaptured();

        if (score !== lastScore) {
            scoreVal.textContent = String(score).padStart(6, '0');
            lastScore = score;
        }

        if (percent !== lastPercent) {
            areaVal.textContent = percent.toFixed(1) + '%';
            lastPercent = percent;
        }

        if (lives !== lastLives) {
            livesVal.textContent = lives;
            lastLives = lives;
        }

        if (level !== lastLevel) {
            levelVal.textContent = level;
            lastLevel = level;
        }

        if (status !== lastStatus) {
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
            lastStatus = status;
        }
    }

    // Shared logic for starting / restarting the game
    function startGame() {
        const status = fnGetGameStatus();
        if (status === StartScreen || status === GameOver) {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
            }
            fnOnStart();
            keepRunning = true;
            lastTime = performance.now();
            animationFrameId = requestAnimationFrame(tick);
        }
    }

    // Map modern e.key values to the legacy numeric key codes that the Pascal
    // side expects (matching the original VK_* constants used in bouncer.pas).
    const KEY_CODES = {
        'Enter':      13,
        ' ':          32,
        'ArrowLeft':  37,
        'ArrowUp':    38,
        'ArrowRight': 39,
        'ArrowDown':  40,
    };

    // Handle key events
    function handleKeyDown(e) {
        const key = KEY_CODES[e.key];
        if (key === undefined) return; // Ignore unrecognised keys early

        // Enter/Space to start/restart — works even when game loop isn't running yet
        if (key === 13 || key === 32) {
            e.preventDefault();
            startGame();
            return;
        }

        // Arrow keys for player movement — only during gameplay
        if (keepRunning) {
            e.preventDefault();
            fnOnKeyDown(key);
        }
    }

    // Game loop
    function tick() {
        const now = performance.now();
        const deltaTime = Math.min((now - lastTime) / 1000.0, 0.1); // seconds, clamped to avoid giant steps after tab-away
        lastTime = now;

        fnStep(deltaTime);
        render();
        updateUI();

        if (keepRunning) {
            animationFrameId = requestAnimationFrame(tick);
        } else {
            animationFrameId = null;
        }
    }

    // Show an error banner inside the canvas container when WASM fails to load.
    function showLoadError(err) {
        const container = document.getElementById('game-canvas')?.parentElement
            ?? document.body;
        const banner = document.createElement('div');
        banner.id = 'wasm-error-banner';
        banner.style.cssText = [
            'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
            'align-items:center', 'justify-content:center', 'background:rgba(0,0,0,.85)',
            'color:#ff6b6b', 'font-family:monospace', 'font-size:1rem',
            'padding:1rem', 'text-align:center', 'z-index:999',
        ].join(';');
        banner.innerHTML = `
            <strong style="font-size:1.4rem;margin-bottom:.5rem">⚠️ Failed to load game</strong>
            <span>${err?.message ?? err}</span>
            <small style="margin-top:.75rem;opacity:.6">Check the browser console for details.</small>`;
        container.style.position = 'relative';
        container.appendChild(banner);
    }

    // Re-initialise canvas pixel buffer when the canvas is resized.
    function handleResize() {
        if (!canvas || !wasmMemory) return;
        // Only act if the canvas element's rendered size has actually changed.
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (w === gameWidth && h === gameHeight) return;
        canvas.width = w;
        canvas.height = h;
        setupCanvas();
    }

    // Tear down listeners and cancel the animation loop on page exit.
    function cleanup() {
        keepRunning = false;
        if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('pagehide', cleanup);
    }

    // Initialize everything
    async function init() {
        try {
            await initWasm();

            // Validate all required DOM elements exist before we touch them
            // (mirrors the getExport pattern for WASM exports)
            ['score-val', 'area-val', 'lives-val', 'level-val', 'final-score-val', 'next-level-val',
             'start-screen', 'game-over-screen', 'level-complete-screen',
             'start-button', 'restart-button', 'game-canvas',
            ].forEach(id => requireDom(id));

            canvas = requireDom('game-canvas');
            if (!canvas.clientWidth || !canvas.clientHeight) {
                throw new Error(
                    `Canvas has no layout size (${canvas.clientWidth}×${canvas.clientHeight}) — ` +
                    `check CSS visibility or container dimensions`
                );
            }
            ctx = canvas.getContext('2d');
            setupCanvas();

            window.addEventListener('keydown', handleKeyDown);
            window.addEventListener('resize', handleResize);
            window.addEventListener('beforeunload', cleanup);
            window.addEventListener('pagehide', cleanup);

            document.getElementById('start-button').addEventListener('click', startGame);
            document.getElementById('restart-button').addEventListener('click', startGame);

            // Initial UI render (shows start-screen state)
            updateUI();

        } catch (e) {
            console.error('Failed to initialize WASM:', e);
            showLoadError(e);
        }
    }

    // Start the game
    init();
})();
