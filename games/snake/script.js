// Snake Game
// Main game variables
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');
const highScoreElement = document.getElementById('high-score');
const finalScoreElement = document.getElementById('final-score');
const foodCountElement = document.getElementById('food-count');
const speedLevelElement = document.getElementById('speed-level');
const gameStatusElement = document.getElementById('game-status');

// Game state variables
let snake = [];
let food = {};
let direction = 'right';
let nextDirection = 'right';
let gameInterval;
let score = 0;
let highScore = localStorage.getItem('snakeHighScore') || 0;
let foodCount = 0;
let speedLevel = 1;
let gameRunning = false;
let gamePaused = false;

// Game constants
const gridSize = 20;
const gridWidth = canvas.width / gridSize;
const gridHeight = canvas.height / gridSize;
const baseSpeed = 150; // milliseconds

// DOM elements
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');
const playAgainBtn = document.getElementById('play-again-btn');
const startScreenBtn = document.getElementById('start-screen-btn');
const gameOverScreen = document.getElementById('game-over');
const startScreen = document.getElementById('start-screen');

// Initialize game
function initGame() {
    // Set high score
    highScoreElement.textContent = highScore;
    
    // Initialize snake
    snake = [
        {x: 5, y: 10},
        {x: 4, y: 10},
        {x: 3, y: 10}
    ];
    
    // Generate first food
    generateFood();
    
    // Reset game state
    direction = 'right';
    nextDirection = 'right';
    score = 0;
    foodCount = 0;
    speedLevel = 1;
    
    // Update UI
    scoreElement.textContent = score;
    foodCountElement.textContent = foodCount;
    speedLevelElement.textContent = speedLevel;
    gameStatusElement.textContent = 'Ready';
    
    // Hide game over screen
    gameOverScreen.style.display = 'none';
    startScreen.style.display = 'flex';
    
    // Draw initial state
    draw();
}

// Generate food at random position
function generateFood() {
    let foodOnSnake;
    
    do {
        foodOnSnake = false;
        food = {
            x: Math.floor(Math.random() * gridWidth),
            y: Math.floor(Math.random() * gridHeight)
        };
        
        // Check if food is on snake
        for (let segment of snake) {
            if (segment.x === food.x && segment.y === food.y) {
                foodOnSnake = true;
                break;
            }
        }
    } while (foodOnSnake);
}

// Draw game elements
function draw() {
    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw grid (optional, for visual reference)
    drawGrid();
    
    // Draw snake
    snake.forEach((segment, index) => {
        // Snake head
        if (index === 0) {
            ctx.fillStyle = '#2ecc71'; // Green head
            ctx.fillRect(segment.x * gridSize, segment.y * gridSize, gridSize, gridSize);
            
            // Draw eyes on head
            ctx.fillStyle = '#000';
            const eyeSize = gridSize / 5;
            const eyeOffset = gridSize / 3;
            
            // Eye positions based on direction
            if (direction === 'right') {
                ctx.fillRect(segment.x * gridSize + gridSize - eyeOffset, segment.y * gridSize + eyeOffset, eyeSize, eyeSize);
                ctx.fillRect(segment.x * gridSize + gridSize - eyeOffset, segment.y * gridSize + gridSize - eyeOffset - eyeSize, eyeSize, eyeSize);
            } else if (direction === 'left') {
                ctx.fillRect(segment.x * gridSize + eyeOffset - eyeSize, segment.y * gridSize + eyeOffset, eyeSize, eyeSize);
                ctx.fillRect(segment.x * gridSize + eyeOffset - eyeSize, segment.y * gridSize + gridSize - eyeOffset - eyeSize, eyeSize, eyeSize);
            } else if (direction === 'up') {
                ctx.fillRect(segment.x * gridSize + eyeOffset, segment.y * gridSize + eyeOffset - eyeSize, eyeSize, eyeSize);
                ctx.fillRect(segment.x * gridSize + gridSize - eyeOffset - eyeSize, segment.y * gridSize + eyeOffset - eyeSize, eyeSize, eyeSize);
            } else if (direction === 'down') {
                ctx.fillRect(segment.x * gridSize + eyeOffset, segment.y * gridSize + gridSize - eyeOffset, eyeSize, eyeSize);
                ctx.fillRect(segment.x * gridSize + gridSize - eyeOffset - eyeSize, segment.y * gridSize + gridSize - eyeOffset, eyeSize, eyeSize);
            }
        } else {
            // Snake body
            const colorValue = 150 - (index % 5) * 10;
            ctx.fillStyle = `rgb(46, 204, ${colorValue})`;
            ctx.fillRect(segment.x * gridSize, segment.y * gridSize, gridSize, gridSize);
            
            // Body border for better visibility
            ctx.strokeStyle = '#1a1a2e';
            ctx.lineWidth = 1;
            ctx.strokeRect(segment.x * gridSize, segment.y * gridSize, gridSize, gridSize);
        }
    });
    
    // Draw food
    ctx.fillStyle = '#e74c3c'; // Red food
    ctx.beginPath();
    ctx.arc(
        food.x * gridSize + gridSize / 2,
        food.y * gridSize + gridSize / 2,
        gridSize / 2,
        0,
        Math.PI * 2
    );
    ctx.fill();
    
    // Draw food shine effect
    ctx.fillStyle = '#ff8c7a';
    ctx.beginPath();
    ctx.arc(
        food.x * gridSize + gridSize / 3,
        food.y * gridSize + gridSize / 3,
        gridSize / 6,
        0,
        Math.PI * 2
    );
    ctx.fill();
}

// Draw grid lines
function drawGrid() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    
    // Vertical lines
    for (let x = 0; x <= canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    
    // Horizontal lines
    for (let y = 0; y <= canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
}

// Update game state
function update() {
    // Update direction
    direction = nextDirection;
    
    // Calculate new head position
    const head = {...snake[0]};
    
    switch(direction) {
        case 'up':
            head.y -= 1;
            break;
        case 'down':
            head.y += 1;
            break;
        case 'left':
            head.x -= 1;
            break;
        case 'right':
            head.x += 1;
            break;
    }
    
    // Check wall collision
    if (head.x < 0 || head.x >= gridWidth || head.y < 0 || head.y >= gridHeight) {
        gameOver();
        return;
    }
    
    // Check self collision
    for (let segment of snake) {
        if (head.x === segment.x && head.y === segment.y) {
            gameOver();
            return;
        }
    }
    
    // Add new head to snake
    snake.unshift(head);
    
    // Check food collision
    if (head.x === food.x && head.y === food.y) {
        // Increase score
        score += 10;
        scoreElement.textContent = score;
        
        // Update food count
        foodCount++;
        foodCountElement.textContent = foodCount;
        
        // Update high score if needed
        if (score > highScore) {
            highScore = score;
            highScoreElement.textContent = highScore;
            localStorage.setItem('snakeHighScore', highScore);
        }
        
        // Increase speed every 5 foods
        if (foodCount % 5 === 0) {
            speedLevel++;
            speedLevelElement.textContent = speedLevel;
            
            // Clear existing interval and start new one with faster speed
            clearInterval(gameInterval);
            const newSpeed = Math.max(50, baseSpeed - (speedLevel - 1) * 10);
            gameInterval = setInterval(update, newSpeed);
        }
        
        // Generate new food
        generateFood();
    } else {
        // Remove tail if no food eaten
        snake.pop();
    }
    
    // Draw updated game state
    draw();
}

// Game over function
function gameOver() {
    gameRunning = false;
    gameStatusElement.textContent = 'Game Over';
    
    // Clear game interval
    clearInterval(gameInterval);
    
    // Show final score
    finalScoreElement.textContent = score;
    
    // Show game over screen
    gameOverScreen.style.display = 'flex';
}

// Start game
function startGame() {
    if (gameRunning) return;
    
    gameRunning = true;
    gamePaused = false;
    gameStatusElement.textContent = 'Playing';
    
    // Hide start screen
    startScreen.style.display = 'none';
    gameOverScreen.style.display = 'none';
    
    // Calculate speed based on level
    const currentSpeed = Math.max(50, baseSpeed - (speedLevel - 1) * 10);
    
    // Start game loop
    gameInterval = setInterval(update, currentSpeed);
}

// Pause/Resume game
function togglePause() {
    if (!gameRunning) return;
    
    if (gamePaused) {
        // Resume game
        gamePaused = false;
        gameStatusElement.textContent = 'Playing';
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        
        // Calculate speed based on level
        const currentSpeed = Math.max(50, baseSpeed - (speedLevel - 1) * 10);
        
        // Restart interval
        gameInterval = setInterval(update, currentSpeed);
    } else {
        // Pause game
        gamePaused = true;
        gameStatusElement.textContent = 'Paused';
        pauseBtn.innerHTML = '<i class="fas fa-play"></i> Resume';
        
        // Clear interval
        clearInterval(gameInterval);
    }
}

// Reset game
function resetGame() {
    // Clear interval if running
    if (gameInterval) {
        clearInterval(gameInterval);
    }
    
    // Reset game state
    gameRunning = false;
    gamePaused = false;
    
    // Reinitialize game
    initGame();
    
    // Update button text
    pauseBtn.innerHTML = '<i class="fas fa-pause"></i> Pause';
}

// Handle keyboard input
function handleKeyDown(e) {
    // Prevent default behavior for arrow keys
    if ([37, 38, 39, 40].includes(e.keyCode)) {
        e.preventDefault();
    }
    
    // Only process if game is running and not paused
    if (!gameRunning || gamePaused) return;
    
    // Update direction based on key press
    switch(e.keyCode) {
        case 38: // Up arrow
            if (direction !== 'down') nextDirection = 'up';
            break;
        case 40: // Down arrow
            if (direction !== 'up') nextDirection = 'down';
            break;
        case 37: // Left arrow
            if (direction !== 'right') nextDirection = 'left';
            break;
        case 39: // Right arrow
            if (direction !== 'left') nextDirection = 'right';
            break;
        case 32: // Space bar - pause/resume
            togglePause();
            break;
    }
}

// Event listeners
startBtn.addEventListener('click', startGame);
pauseBtn.addEventListener('click', togglePause);
resetBtn.addEventListener('click', resetGame);
playAgainBtn.addEventListener('click', resetGame);
startScreenBtn.addEventListener('click', startGame);

// Keyboard controls
document.addEventListener('keydown', handleKeyDown);

// Initialize game on load
window.addEventListener('load', initGame);