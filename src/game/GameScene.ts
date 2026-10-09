import Phaser from 'phaser';

// ─── Игровые константы ─────────────────────────────────────────────────
// Все важные параметры вынесены сюда, чтобы их было легко менять.
const GAME_WIDTH = 960;
const GAME_HEIGHT = 640;

const PLAYER_RADIUS = 12;          // радиус коллизии корабля (круг-круг)
const TURN_SPEED = 3.2;            // скорость поворота, рад/с
const CHARGING_TURN_FACTOR = 0.5;  // при зарядке поворот замедляется на 50%
const THRUST = 420;                // ускорение от импульса, px/с²
const MAX_SPEED = 460;             // предел скорости, чтобы корабль был управляемым

const CHARGE_RATE = 1 / 9;         // зарядка: 0→100% примерно за 9 секунд
const CHARGE_DRAIN = 1 / 2.5;      // разряд: 100%→0 примерно за 2.5 секунды
const CENTER_CHARGE_RADIUS = 100;  // внутри этого радиуса зарядка максимально быстрая
const EDGE_CHARGE_RADIUS = 400;    // на этом радиусе и дальше зарядка медленная
const EDGE_CHARGE_PENALTY = 0.5;   // множитель зарядки на краю (1.0 → 0.5)

const CHARGE_BAR_WIDTH = 300;
const CHARGE_BAR_HEIGHT = 20;
const HUD_Y = 34;

const ASTEROID_MIN_RADIUS = 15;
const ASTEROID_MAX_RADIUS = 40;
const ASTEROID_MIN_SPEED = 60;      // px/с — это 1 px/кадр при 60 fps
const ASTEROID_MAX_SPEED = 180;     // px/с — это 3 px/кадр при 60 fps
// Сложность влияет на количество астероидов.
const DIFFICULTIES = {
  easy: { label: 'ЛЕГКИЙ', startCount: 3, maxCount: 10 },
  medium: { label: 'СРЕДНИЙ', startCount: 5, maxCount: 15 },
  hard: { label: 'СЛОЖНЫЙ', startCount: 7, maxCount: 20 },
} as const;

type Difficulty = keyof typeof DIFFICULTIES;

const ASTEROID_COUNT_RAMP = 15;     // каждые N секунд добавляется ещё один астероид
const ASTEROID_SPEED_RAMP = 90;     // за это время базовая скорость астероидов удваивается
const ASTEROID_SPEED_CAP = 2.5;     // предел роста скорости астероидов

const STAR_COUNT = 80;

const SHIP_COLOR = 0xffffff;
const SHIP_STROKE = 0xbbbbbb;
const ASTEROID_COLOR = 0x888888;
const ASTEROID_STROKE = 0xaaaaaa;
const CHARGE_BLUE = 0x3a86ff;
const CHARGE_GOLD = 0xffbe0b;
const BAR_BACKGROUND = 0x333333;
const BAR_BORDER = 0x555555;
const WHITE = 0xffffff;
const HUD_TEXT = '#ffffff';
const LOSE_TEXT = '#ff4444';
const SUBTITLE_TEXT = '#cbd5e1';
const HINT_TEXT = '#9ca3af';

// ─── Вспомогательные типы ──────────────────────────────────────────────
interface Star {
  dot: Phaser.GameObjects.Arc;
  baseAlpha: number;
  twinkleSpeed: number;
  phase: number;
}

interface Asteroid {
  shape: Phaser.GameObjects.Polygon;
  vx: number;
  vy: number;
  radius: number;
}

type GameState = 'menu' | 'playing' | 'won' | 'lost';

/**
 * Линейная интерполяция цвета между двумя значениями 0xRRGGBB.
 */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * «Hyperjump» — аркадный выживач с одной кнопкой действия.
 *
 * Ты — пилот последнего корабля у умирающей звезды. Заряди гипердвигатель
 * до 100%, уклоняясь от астероидов, и прыгни, пока звезда не взорвалась.
 *
 * Управление:
 *  - 1 / 2 / 3 или клик мыши — выбор сложности в меню
 *  - A / ← — поворот влево
 *  - D / → — поворот вправо
 *  - W / ↑ — импульс вперёд (инерция, без самоторможения)
 *  - SPACE (удержание) — зарядка гипердвигателя
 *  - R — рестарт после победы или поражения (возврат в меню)
 */
export class GameScene extends Phaser.Scene {
  // Корабль и его физика
  private ship!: Phaser.GameObjects.Triangle;
  private chargeRing!: Phaser.GameObjects.Arc;
  private angle = 0;   // угол корабля, 0 = «смотрит вверх»
  private vx = 0;      // скорость по X, px/с
  private vy = 0;      // скорость по Y, px/с

  // Прогресс гипердвигателя: 0..1
  private hyperCharge = 0;

  // Состояние партии
  private state: GameState = 'menu';
  private difficulty: Difficulty = 'medium';
  private elapsed = 0;       // общее время партии, с
  private survivalTime = 0;  // время выживания для таймера, с
  private spawnTimer = 0;    // задержка перед появлением следующего астероида

  // Объекты на сцене
  private stars: Star[] = [];
  private asteroids: Asteroid[] = [];

  // Меню выбора сложности
  private menuTexts: Phaser.GameObjects.Text[] = [];
  private menuDigitKeys: Phaser.Input.Keyboard.Key[] = [];

  // HUD
  private chargeBarBg!: Phaser.GameObjects.Rectangle;
  private chargeBarFill!: Phaser.GameObjects.Rectangle;
  private chargePercentText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;

  // Ввод
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  private space!: Phaser.Input.Keyboard.Key;
  private rKey!: Phaser.Input.Keyboard.Key;

  constructor() {
    super('GameScene');
  }

  create(): void {
    // scene.restart() переиспользует тот же экземпляр сцены, поэтому всё
    // изменяемое состояние нужно сбрасывать здесь, а не только в полях класса.
    this.hyperCharge = 0;
    this.state = 'menu';
    this.difficulty = 'medium';
    this.elapsed = 0;
    this.survivalTime = 0;
    this.spawnTimer = 0;
    this.angle = 0;
    this.vx = 0;
    this.vy = 0;
    this.stars = [];
    this.asteroids = [];

    this.createStars();
    this.createShip();
    this.createHud();
    this.setupInput();
    this.createMenu();
    this.setGameObjectsVisible(false);
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;
    this.elapsed += dt;

    // В меню ждём выбора сложности: клик по пункту или клавиши 1/2/3.
    if (this.state === 'menu') {
      const order: Difficulty[] = ['easy', 'medium', 'hard'];
      for (let i = 0; i < this.menuDigitKeys.length; i++) {
        if (Phaser.Input.Keyboard.JustDown(this.menuDigitKeys[i])) {
          this.startGame(order[i]);
          return;
        }
      }
      return;
    }

    // После победы/поражения R возвращает в меню выбора сложности.
    if (this.state !== 'playing') {
      if (Phaser.Input.Keyboard.JustDown(this.rKey)) {
        this.scene.restart();
      }
      return;
    }

    this.survivalTime += dt;
    this.timerText.setText(`${Math.floor(this.survivalTime)}s`);

    const charging = this.space.isDown;

    this.updateShipMovement(charging, dt);
    this.updateCharging(charging, dt);
    this.updateChargeRing(charging);
    this.updateStars();

    // Победа — заряд достиг 100%.
    if (this.hyperCharge >= 1) {
      this.winGame();
      return;
    }

    this.spawnAsteroids(dt);
    this.moveAsteroids(dt);
    this.checkCollisions();
  }

  // ─── Меню выбора сложности ───────────────────────────────────────────
  private createMenu(): void {
    const cx = GAME_WIDTH / 2;
    const addMenuText = (
      y: number,
      text: string,
      size: string,
      color: string,
    ): Phaser.GameObjects.Text =>
      this.add
        .text(cx, y, text, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: size,
          color,
        })
        .setOrigin(0.5)
        .setDepth(30);

    this.menuTexts.push(addMenuText(200, 'HYPERJUMP', '52px', '#ffbe0b'));
    this.menuTexts.push(
      addMenuText(262, 'Заряди гипердвигатель до 100% и прыгни', '22px', SUBTITLE_TEXT),
    );
    this.menuTexts.push(addMenuText(330, 'Выбери сложность:', '26px', HUD_TEXT));

    const entries: { difficulty: Difficulty; hint: string }[] = [
      { difficulty: 'easy', hint: 'мало астероидов' },
      { difficulty: 'medium', hint: 'средне астероидов' },
      { difficulty: 'hard', hint: 'много астероидов' },
    ];
    entries.forEach((entry, i) => {
      const label = DIFFICULTIES[entry.difficulty].label;
      const item = this.add
        .text(cx, 390 + i * 52, `${i + 1}. ${label} — ${entry.hint}`, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '28px',
          color: HUD_TEXT,
        })
        .setOrigin(0.5)
        .setDepth(30)
        .setInteractive({ useHandCursor: true });
      item.on('pointerdown', () => this.startGame(entry.difficulty));
      this.menuTexts.push(item);
    });
  }

  private startGame(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    this.menuTexts.forEach((t) => t.destroy());
    this.menuTexts = [];
    this.elapsed = 0;
    this.survivalTime = 0;
    this.setGameObjectsVisible(true);
    this.state = 'playing';
  }

  /** Показывает/скрывает игровые объекты (в меню они не нужны). */
  private setGameObjectsVisible(visible: boolean): void {
    this.ship.setVisible(visible);
    this.chargeRing.setVisible(visible);
    this.chargeBarBg.setVisible(visible);
    this.chargeBarFill.setVisible(visible);
    this.chargePercentText.setVisible(visible);
    this.timerText.setVisible(visible);
    this.hintText.setVisible(visible);
  }

  // ─── Корабль ─────────────────────────────────────────────────────────
  private createShip(): void {
    // Белый треугольник, нос «смотрит вверх»: (0,-18) вершина, два задних угла.
    this.ship = this.add
      .triangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 0, -18, -12, 14, 12, 14, SHIP_COLOR)
      .setDepth(10);
    this.ship.setStrokeStyle(1.5, SHIP_STROKE);

    // Пульсирующее кольцо зарядки — окружность с обводкой, без заливки.
    this.chargeRing = this.add
      .circle(0, 0, PLAYER_RADIUS + 6, CHARGE_BLUE, 0)
      .setVisible(false)
      .setDepth(11);
  }

  private updateShipMovement(charging: boolean, dt: number): void {
    // При зарядке поворот замедляется на 50%.
    const turnSpeed = TURN_SPEED * (charging ? CHARGING_TURN_FACTOR : 1);
    if (this.cursors.left.isDown || this.wasd.left.isDown) this.angle -= turnSpeed * dt;
    if (this.cursors.right.isDown || this.wasd.right.isDown) this.angle += turnSpeed * dt;
    this.ship.setRotation(this.angle);

    // Импульс «вперёд» по направлению носа корабля (инерция, без торможения).
    if (this.cursors.up.isDown || this.wasd.up.isDown) {
      this.vx += Math.sin(this.angle) * THRUST * dt;
      this.vy += -Math.cos(this.angle) * THRUST * dt;
    }

    // Ограничиваем максимальную скорость, иначе корабль разгонится без предела.
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > MAX_SPEED) {
      this.vx = (this.vx / speed) * MAX_SPEED;
      this.vy = (this.vy / speed) * MAX_SPEED;
    }

    this.ship.x += this.vx * dt;
    this.ship.y += this.vy * dt;

    this.clampShipToScreen();
  }

  private clampShipToScreen(): void {
    // Мягкие границы экрана: корабль не покидает поле, скорость «наружу» гасится.
    const margin = PLAYER_RADIUS + 4;
    if (this.ship.x < margin) {
      this.ship.x = margin;
      if (this.vx < 0) this.vx = 0;
    }
    if (this.ship.x > GAME_WIDTH - margin) {
      this.ship.x = GAME_WIDTH - margin;
      if (this.vx > 0) this.vx = 0;
    }
    if (this.ship.y < margin) {
      this.ship.y = margin;
      if (this.vy < 0) this.vy = 0;
    }
    if (this.ship.y > GAME_HEIGHT - margin) {
      this.ship.y = GAME_HEIGHT - margin;
      if (this.vy > 0) this.vy = 0;
    }
  }

  // ─── Зарядка гипердвигателя ──────────────────────────────────────────
  private updateCharging(charging: boolean, dt: number): void {
    if (charging) {
      // Пока зажата SPACE — зарядка растёт, но зависит от расстояния до центра.
      this.hyperCharge = Math.min(
        1,
        this.hyperCharge + CHARGE_RATE * this.chargeRateMultiplier() * dt,
      );
    } else {
      // Отпустили SPACE — заряд быстро стекает к нулю.
      this.hyperCharge = Math.max(0, this.hyperCharge - CHARGE_DRAIN * dt);
    }
    this.updateChargeHud();
  }

  /**
   * Множитель скорости зарядки в зависимости от расстояния до центра экрана:
   * 1.0 внутри радиуса CENTER_CHARGE_RADIUS, плавно падает до
   * 1 - EDGE_CHARGE_PENALTY = 0.5 на радиусе EDGE_CHARGE_RADIUS и дальше.
   */
  private chargeRateMultiplier(): number {
    const dist = Phaser.Math.Distance.Between(
      this.ship.x,
      this.ship.y,
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
    );
    const t = Phaser.Math.Clamp(
      (dist - CENTER_CHARGE_RADIUS) / (EDGE_CHARGE_RADIUS - CENTER_CHARGE_RADIUS),
      0,
      1,
    );
    return 1 - EDGE_CHARGE_PENALTY * t;
  }

  private updateChargeRing(charging: boolean): void {
    this.chargeRing.setVisible(charging);
    if (!charging) return;

    // Цвет кольца зависит от прогресса: синий → золотой.
    const color = lerpColor(CHARGE_BLUE, CHARGE_GOLD, this.hyperCharge);
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 7);
    this.chargeRing.setPosition(this.ship.x, this.ship.y);
    this.chargeRing.setRadius(PLAYER_RADIUS + 6 + pulse * 5 + this.hyperCharge * 12);
    this.chargeRing.setStrokeStyle(2.5, color);
  }

  // ─── HUD ──────────────────────────────────────────────────────────────
  private createHud(): void {
    const barX = GAME_WIDTH / 2 - CHARGE_BAR_WIDTH / 2;
    const barY = HUD_Y;

    // Тёмный фон шкалы зарядки.
    this.chargeBarBg = this.add
      .rectangle(barX + CHARGE_BAR_WIDTH / 2, barY, CHARGE_BAR_WIDTH, CHARGE_BAR_HEIGHT, BAR_BACKGROUND)
      .setDepth(20);
    this.chargeBarBg.setStrokeStyle(1, BAR_BORDER);

    // Заполнение: растягивается от левого края по мере роста hyperCharge,
    // цвет — градиент от синего к золотому (плавно по прогрессу).
    this.chargeBarFill = this.add
      .rectangle(barX, barY, CHARGE_BAR_WIDTH, CHARGE_BAR_HEIGHT, CHARGE_BLUE)
      .setDepth(21);
    this.chargeBarFill.setOrigin(0, 0.5);
    this.chargeBarFill.setScale(0, 1);

    // Процент зарядки рядом со шкалой.
    this.chargePercentText = this.add
      .text(barX + CHARGE_BAR_WIDTH + 14, barY, '0%', {
        fontFamily: 'monospace',
        fontSize: '26px',
        color: HUD_TEXT,
      })
      .setOrigin(0, 0.5)
      .setDepth(22);

    // Таймер выживания справа сверху.
    this.timerText = this.add
      .text(GAME_WIDTH - 24, HUD_Y, '0s', {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: HUD_TEXT,
      })
      .setOrigin(1, 0.5)
      .setDepth(22);

    // Подсказка для новичка — слева сверху.
    this.hintText = this.add
      .text(16, 16, 'SPACE — зарядка гиперпрыжка', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: HINT_TEXT,
      })
      .setDepth(22);
  }

  private updateChargeHud(): void {
    this.chargeBarFill.setScale(this.hyperCharge, 1);
    this.chargePercentText.setText(`${Math.round(this.hyperCharge * 100)}%`);
    this.chargeBarFill.setFillStyle(lerpColor(CHARGE_BLUE, CHARGE_GOLD, this.hyperCharge));

    // При зарядке выше 80% шкала пульсирует.
    if (this.hyperCharge > 0.8) {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 12);
      this.chargeBarFill.setAlpha(0.7 + 0.3 * pulse);
    } else {
      this.chargeBarFill.setAlpha(1);
    }
  }

  // ─── Звёзды фона ──────────────────────────────────────────────────────
  private createStars(): void {
    for (let i = 0; i < STAR_COUNT; i++) {
      const dot = this.add.circle(
        Phaser.Math.Between(0, GAME_WIDTH),
        Phaser.Math.Between(0, GAME_HEIGHT),
        Phaser.Math.FloatBetween(0.6, 1.6),
        WHITE,
      );
      const baseAlpha = Phaser.Math.FloatBetween(0.25, 0.9);
      dot.setAlpha(baseAlpha);
      this.stars.push({
        dot,
        baseAlpha,
        twinkleSpeed: Phaser.Math.FloatBetween(1, 3),
        phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      });
    }
  }

  private updateStars(): void {
    // Медленное мерцание: прозрачность меняется по синусоиде.
    for (const star of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(this.elapsed * star.twinkleSpeed + star.phase);
      star.dot.setAlpha(star.baseAlpha * (0.55 + 0.45 * twinkle));
    }
  }

  // ─── Астероиды ────────────────────────────────────────────────────────
  /**
   * Спавнит астероиды с краёв экрана. Количество растёт со временем
   * от ASTEROID_START_COUNT до ASTEROID_MAX_COUNT.
   */
  private spawnAsteroids(dt: number): void {
    const difficulty = DIFFICULTIES[this.difficulty];
    const maxCount = Math.min(
      difficulty.maxCount,
      difficulty.startCount + Math.floor(this.elapsed / ASTEROID_COUNT_RAMP),
    );

    this.spawnTimer -= dt;
    if (this.asteroids.length >= maxCount || this.spawnTimer > 0) return;
    this.spawnTimer = Phaser.Math.FloatBetween(0.3, 0.8);

    // Случайная точка на одной из четырёх сторон экрана.
    const side = Phaser.Math.Between(0, 3);
    let x = 0;
    let y = 0;
    switch (side) {
      case 0: // сверху
        x = Phaser.Math.Between(0, GAME_WIDTH);
        y = -10;
        break;
      case 1: // снизу
        x = Phaser.Math.Between(0, GAME_WIDTH);
        y = GAME_HEIGHT + 10;
        break;
      case 2: // слева
        x = -10;
        y = Phaser.Math.Between(0, GAME_HEIGHT);
        break;
      default: // справа
        x = GAME_WIDTH + 10;
        y = Phaser.Math.Between(0, GAME_HEIGHT);
        break;
    }

    // Летим в сторону центра экрана с небольшим разбросом по углу.
    const baseAngle = Math.atan2(GAME_HEIGHT / 2 - y, GAME_WIDTH / 2 - x);
    const angle = baseAngle + Phaser.Math.FloatBetween(-0.6, 0.6);

    // Базовая скорость со временем постепенно растёт.
    const speedScale = 1 + Math.min(ASTEROID_SPEED_CAP, this.elapsed / ASTEROID_SPEED_RAMP);
    const speed = Phaser.Math.FloatBetween(ASTEROID_MIN_SPEED, ASTEROID_MAX_SPEED) * speedScale;

    const radius = Phaser.Math.FloatBetween(ASTEROID_MIN_RADIUS, ASTEROID_MAX_RADIUS);
    const shape = this.add.polygon(x, y, this.makeAsteroidPoints(radius), ASTEROID_COLOR);
    shape.setStrokeStyle(1.5, ASTEROID_STROKE);

    this.asteroids.push({
      shape,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius,
    });
  }

  /**
   * Строит набор точек многоугольника астероида: 7–10 вершин,
   * радиус вершин слегка колеблется вокруг заданного радиуса.
   */
  private makeAsteroidPoints(radius: number): Phaser.Types.Math.Vector2Like[] {
    const vertices = Phaser.Math.Between(7, 10);
    const points: Phaser.Types.Math.Vector2Like[] = [];
    for (let i = 0; i < vertices; i++) {
      const angle = (i / vertices) * Math.PI * 2;
      const r = radius * Phaser.Math.FloatBetween(0.72, 1.05);
      points.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    return points;
  }

  private moveAsteroids(dt: number): void {
    for (let i = this.asteroids.length - 1; i >= 0; i--) {
      const a = this.asteroids[i];
      a.shape.x += a.vx * dt;
      a.shape.y += a.vy * dt;

      // Астероид, улетевший далеко за экран, удаляем.
      if (
        a.shape.x < -80 ||
        a.shape.x > GAME_WIDTH + 80 ||
        a.shape.y < -80 ||
        a.shape.y > GAME_HEIGHT + 80
      ) {
        a.shape.destroy();
        this.asteroids.splice(i, 1);
      }
    }
  }

  /**
   * Проверка столкновений круг-круг: радиус корабля + радиус астероида.
   */
  private checkCollisions(): void {
    for (const a of this.asteroids) {
      const dist = Phaser.Math.Distance.Between(this.ship.x, this.ship.y, a.shape.x, a.shape.y);
      if (dist <= PLAYER_RADIUS + a.radius) {
        this.loseGame();
        return;
      }
    }
  }

  // ─── Победа и поражение ───────────────────────────────────────────────
  private winGame(): void {
    this.state = 'won';
    this.ship.setVisible(false);
    this.chargeRing.setVisible(false);
    this.updateChargeHud();

    // Экран вспыхивает белым и гаснет за 0.5 секунды.
    const flash = this.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      GAME_WIDTH,
      GAME_HEIGHT,
      WHITE,
    );
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 500,
      onComplete: () => flash.destroy(),
    });

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, 'HYPERJUMP SUCCESSFUL', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '38px',
        color: '#ffbe0b',
      })
      .setOrigin(0.5);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 34, 'Press R to restart', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: HINT_TEXT,
      })
      .setOrigin(0.5);
  }

  private loseGame(): void {
    this.state = 'lost';
    this.cameras.main.shake(350, 0.008); // небольшая тряска экрана
    this.ship.setVisible(false);
    this.chargeRing.setVisible(false);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 36, 'HYPERJUMP FAILED', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '40px',
        color: LOSE_TEXT,
      })
      .setOrigin(0.5);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 4, 'SHIP DESTROYED', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '24px',
        color: SUBTITLE_TEXT,
      })
      .setOrigin(0.5);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 44, 'Press R to restart', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '20px',
        color: HINT_TEXT,
      })
      .setOrigin(0.5);
  }

  // ─── Ввод ─────────────────────────────────────────────────────────────
  private setupInput(): void {
    if (!this.input.keyboard) {
      throw new Error('Keyboard input is unavailable.');
    }
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
    this.space = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.rKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    this.menuDigitKeys = [
      Phaser.Input.Keyboard.KeyCodes.ONE,
      Phaser.Input.Keyboard.KeyCodes.TWO,
      Phaser.Input.Keyboard.KeyCodes.THREE,
    ].map((code) => this.input.keyboard!.addKey(code));
  }
}
