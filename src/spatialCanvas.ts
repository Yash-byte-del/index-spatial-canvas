import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DistanceGrabbable,
  DoubleSide,
  Entity,
  Euler,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RayInteractable,
  RingGeometry,
  SphereGeometry,
  Types,
  Vector3,
  createComponent,
  createSystem,
} from '@iwsdk/core';

// --- ECS Components ---
export const VoiceOrb = createComponent('VoiceOrb', {});
export const SynthButton = createComponent('SynthButton', {});
export const ClearButton = createComponent('ClearButton', {});
export const IdeaCard = createComponent('IdeaCard', {
  priority: { type: Types.Int8, default: 0 }, // 0 = Do Now, 1 = Next, 2 = Park
  targetX: { type: Types.Float32, default: 0 },
  targetY: { type: Types.Float32, default: 1.35 },
  targetZ: { type: Types.Float32, default: -1.02 },
  moving: { type: Types.Int8, default: 0 },
});

interface ParsedIdea {
  text: string;
  tag: string;
  tip: string;
  priority: 0 | 1 | 2;
}

interface CardRecord {
  entity: Entity;
  tabEntity: Entity;
  tipEntity: Entity;
  priority: 0 | 1 | 2;
  height: number;
  tipOpen: boolean;
  tipProgress: number;
  cardHovered: boolean;
  tabHovered: boolean;
  frontMat: MeshStandardMaterial;
  tabMat: MeshStandardMaterial;
}

const CARD_WIDTH = 0.32;
const TIP_WIDTH = 0.26;

const SAMPLE_BRAINDUMPS = [
  'Fix the login bug before tonight, record the 3 minute demo video, and maybe explore multi-user sync later',
  'Submit the Devpost page before deadline, test seated posture in simulator, and research custom shaders later',
  'Polish spatial card contrast, test voice commands in XR, and brainstorm future templates',
];

const SYSTEM_PROMPT = `You are a spatial productivity AI inside a Mixed Reality headset.
Convert messy spoken braindumps into concise, actionable 3D task cards with a helpful micro-suggestion.
Return ONLY valid JSON matching this exact schema:
{
  "tasks": [
    {
      "title": "2 to 6 word crisp action item without filler words",
      "tag": "2 word uppercase label e.g. URGENT BUG, QUICK WIN, DEMO PREP, FUTURE IDEA",
      "tip": "1 crisp actionable next micro-step or tool suggestion (max 11 words)",
      "priority": 0
    }
  ]
}
Priority rules:
0 = DO NOW (urgent, deadlines, bugs, today/tonight, blockers)
1 = NEXT (important next steps, building, testing, polishing)
2 = PARK (someday, later, optional ideas, future research)
Keep related phrases together (e.g. "UI and UX" is ONE task). Max 5 tasks.`;

// --- Real AI API Call (Auto-detects Groq gsk_ or Google Gemini AIza key) ---
async function extractIdeasWithAI(transcript: string): Promise<ParsedIdea[]> {
  const apiKey = ((import.meta as any).env?.VITE_AI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'paste_your_api_key_here') {
    return fallbackParse(transcript);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    let rawJsonText = '';

    if (apiKey.startsWith('gsk_')) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: transcript },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const data = await res.json();
      rawJsonText = data.choices?.[0]?.message?.content || '';
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: transcript }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    clearTimeout(timeout);
    const parsed = JSON.parse(rawJsonText);
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];

    if (tasks.length === 0) return fallbackParse(transcript);

    return tasks.slice(0, 5).map((t: any) => {
      const p = Number(t.priority);
      const priority: 0 | 1 | 2 = p === 0 ? 0 : p === 2 ? 2 : 1;
      return {
        text: String(t.title || transcript).slice(0, 64),
        tag: String(
          t.tag || (priority === 0 ? 'DO NOW' : priority === 2 ? 'PARK LATER' : 'NEXT STEP')
        ).slice(0, 22),
        tip: String(t.tip || 'Break into a 15-minute focused sprint first.').slice(0, 82),
        priority,
      };
    });
  } catch (err) {
    clearTimeout(timeout);
    console.warn('AI API fallback triggered:', err);
    return fallbackParse(transcript);
  }
}

function fallbackParse(transcript: string): ParsedIdea[] {
  const parts = transcript
    .split(/,| and | then |\./i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  const items = parts.length > 0 ? parts : [transcript.trim()];
  return items.slice(0, 5).map((raw) => {
    const text = raw.charAt(0).toUpperCase() + raw.slice(1);
    const lower = text.toLowerCase();
    const priority: 0 | 1 | 2 = /today|tonight|now|fix|bug|submit|deadline|record|demo|urgent/.test(lower)
      ? 0
      : /later|future|explore|brainstorm|maybe|someday|research/.test(lower)
        ? 2
        : 1;
    const tag = priority === 0 ? 'DO NOW' : priority === 2 ? 'PARK LATER' : 'NEXT STEP';
    const tip =
      priority === 0
        ? 'Timebox 20 minutes right now and verify the fix.'
        : priority === 2
          ? 'Save reference links before starting implementation.'
          : 'Test directly inside the XR simulator after building.';
    return { text, tag, tip, priority };
  });
}

// Lightweight procedural spatial audio (0 KB extra assets)
class SpatialAudioFX {
  private ctx: AudioContext | null = null;

  private ensureContext(): AudioContext | null {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freq: number, duration = 0.14, type: OscillatorType = 'sine', delay = 0): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playListenStart(): void {
    this.playTone(523.25, 0.12, 'sine', 0);
    this.playTone(659.25, 0.16, 'sine', 0.08);
  }

  playCardSpawn(): void {
    this.playTone(587.33, 0.12, 'triangle', 0);
    this.playTone(880.0, 0.18, 'triangle', 0.07);
  }

  playTipToggle(opening: boolean): void {
    if (opening) {
      this.playTone(659.25, 0.09, 'sine', 0);
      this.playTone(987.77, 0.14, 'sine', 0.05);
    } else {
      this.playTone(783.99, 0.09, 'sine', 0);
      this.playTone(523.25, 0.12, 'sine', 0.05);
    }
  }

  playOrganize(): void {
    this.playTone(440.0, 0.14, 'sine', 0);
    this.playTone(554.37, 0.14, 'sine', 0.07);
    this.playTone(659.25, 0.22, 'sine', 0.14);
  }

  playClear(): void {
    this.playTone(392.0, 0.12, 'sine', 0);
    this.playTone(293.66, 0.16, 'sine', 0.08);
  }
}

// --- Procedural Study Table & Backdrop Textures ---
function createWoodTableTexture(): CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Warm walnut/oak base gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#7d5634');
  grad.addColorStop(0.5, '#6e4a2b');
  grad.addColorStop(1, '#5c3d22');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle horizontal wood grain streaks
  for (let i = 0; i < 90; i++) {
    const y = (i / 90) * height;
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(42, 24, 10, 0.12)' : 'rgba(215, 168, 118, 0.07)';
    ctx.lineWidth = 1 + (i % 3);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(
      width * 0.33,
      y + Math.sin(i) * 5,
      width * 0.66,
      y - Math.cos(i) * 5,
      width,
      y
    );
    ctx.stroke();
  }

  // Subtle front bevel highlight
  ctx.fillStyle = 'rgba(255, 232, 200, 0.14)';
  ctx.fillRect(0, height - 10, width, 10);

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createDeskMatTexture(): CanvasTexture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#181c26';
  ctx.fillRect(0, 0, width, height);

  // Subtle stitched inner border
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(12, 12, width - 24, height - 24);
  ctx.setLineDash([]);

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createStudyWallTexture(): CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Calm architectural matte slate gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#2a303d');
  grad.addColorStop(0.65, '#202530');
  grad.addColorStop(1, '#171b24');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle vertical acoustic slat lines for depth
  ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
  for (let x = 32; x < width; x += 64) {
    ctx.fillRect(x, 0, 2, height);
  }

  // Warm wood dado trim line matching the desk height
  ctx.fillStyle = '#5c3d22';
  ctx.fillRect(0, height * 0.69, width, 8);

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// --- Canvas Card Helpers (Glassmorphism + Dynamic Height Measurement) ---
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapWords(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 4): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line !== '') {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = testLine;
    }
  }
  if (line && lines.length < maxLines) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [text];
}

function createDynamicGlassCardTexture(
  title: string,
  tag: string,
  bgTop: string,
  bgBottom: string,
  accentHex: string,
  worldWidth = CARD_WIDTH,
  fontSize = 33
): { texture: CanvasTexture; worldHeight: number } {
  const width = 640;
  const padX = 36;
  const lineHeight = Math.round(fontSize * 1.32);

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d')!;
  mCtx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const lines = wrapWords(mCtx, title, width - padX * 2, 4);

  const headerHeight = 88;
  const bottomPad = 28;
  const height = headerHeight + lines.length * lineHeight + bottomPad;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, width, height);

  drawRoundedRect(ctx, 4, 4, width - 8, height - 8, 30);
  ctx.save();
  ctx.clip();

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, bgTop);
  grad.addColorStop(1, bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const sheen = ctx.createLinearGradient(0, 0, 0, height * 0.45);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.11)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, width, height * 0.45);

  ctx.fillStyle = accentHex;
  ctx.fillRect(4, 4, 12, height - 8);

  const cleanTag = tag.toUpperCase();
  ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
  const tagTextWidth = ctx.measureText(cleanTag).width;
  const pillW = tagTextWidth + 28;
  const pillH = 34;

  drawRoundedRect(ctx, padX, 24, pillW, pillH, 17);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fill();
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = accentHex;
  ctx.fillText(cleanTag, padX + 14, 48);

  ctx.fillStyle = '#F8FAFC';
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  lines.forEach((l, idx) => {
    ctx.fillText(l, padX, headerHeight + 16 + idx * lineHeight);
  });

  ctx.restore();

  drawRoundedRect(ctx, 4, 4, width - 8, height - 8, 30);
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.stroke();

  drawRoundedRect(ctx, 8, 8, width - 16, height - 16, 26);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;

  const worldHeight = worldWidth * (height / width);
  return { texture, worldHeight };
}

function createSideTabTexture(accentHex: string, active: boolean): CanvasTexture {
  const width = 96;
  const height = 156;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, width, height);
  drawRoundedRect(ctx, 4, 4, width - 8, height - 8, 24);
  ctx.fillStyle = active ? accentHex : '#182036';
  ctx.fill();

  ctx.strokeStyle = active ? '#FFFFFF' : accentHex;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.font = '44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = active ? '#0F172A' : '#FFFFFF';
  ctx.fillText('💡', width / 2, height * 0.44);

  ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.fillStyle = active ? '#0F172A' : accentHex;
  ctx.fillText('TIP', width / 2, height * 0.78);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createButtonTexture(
  title: string,
  subtitle: string,
  bgTop: string,
  bgBottom: string,
  accentHex: string,
  width = 440,
  height = 140
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, width, height);
  drawRoundedRect(ctx, 4, 4, width - 8, height - 8, 26);

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, bgTop);
  grad.addColorStop(1, bgBottom);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = accentHex;
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(subtitle.toUpperCase(), 26, 48);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.fillText(title, 26, 98);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function buildRoundedCardMaterials(frontTex: CanvasTexture): MeshStandardMaterial[] {
  const invisibleEdge = new MeshStandardMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const faceMat = new MeshStandardMaterial({
    map: frontTex,
    transparent: true,
    alphaTest: 0.05,
    roughness: 0.28,
    metalness: 0.05,
  });
  return [invisibleEdge, invisibleEdge, invisibleEdge, invisibleEdge, faceMat, faceMat];
}

export class SpatialCanvasSystem extends createSystem({
  orbs: { required: [VoiceOrb] },
  synthButtons: { required: [SynthButton] },
  clearButtons: { required: [ClearButton] },
  cards: { required: [IdeaCard] },
}) {
  private orbMat!: MeshStandardMaterial;
  private guideRing!: Mesh;
  private orbHovered = false;
  private btnHovered = false;
  private clearHovered = false;
  private roomBtnHovered = false;
  private roomWallsVisible = true;
  private roomBtnMesh!: Mesh;
  private backdropMeshes: Mesh[] = [];
  private isListening = false;
  private isThinking = false;
  private isOrganized = false;
  private lastTriggerTime = 0;
  private sampleIndex = 0;
  private cardRecords: CardRecord[] = [];
  private headerEntities: Entity[] = [];
  private sfx = new SpatialAudioFX();

  private tmpOffset = new Vector3();
  private tmpEuler = new Euler();
  private tmpQuat = new Quaternion();

  init(): void {
    // 0. Build Minimalist Study Table & Clean Study Backdrop
    this.buildStudyEnvironment();

    // 1. Floating AI Voice Orb (hovering cleanly above the study desk)
    this.orbMat = new MeshStandardMaterial({
      color: new Color(0x00d2ff),
      emissive: new Color(0x0077cc),
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.1,
    });
    const orbMesh = new Mesh(new SphereGeometry(0.085, 32, 32), this.orbMat);
    orbMesh.position.set(0, 1.2, -0.85);

    this.world
      .createTransformEntity(orbMesh)
      .addComponent(VoiceOrb)
      .addComponent(RayInteractable);

    const orbAny = orbMesh as any;
    orbAny.addEventListener('pointerenter', () => {
      this.orbHovered = true;
      if (!this.isListening && !this.isThinking) {
        this.orbMat.emissive.setHex(0x33ccff);
        this.orbMat.emissiveIntensity = 1.4;
      }
    });
    orbAny.addEventListener('pointerleave', () => {
      this.orbHovered = false;
      if (!this.isListening && !this.isThinking) {
        this.orbMat.emissive.setHex(0x0077cc);
        this.orbMat.emissiveIntensity = 0.9;
      }
    });
    orbAny.addEventListener('pointerdown', () => this.handleOrbActivate());
    orbAny.addEventListener('click', () => this.handleOrbActivate());

    // Pulsing guide ring
    const ringMat = new MeshBasicMaterial({
      color: new Color(0x00f0ff),
      side: DoubleSide,
      transparent: true,
      opacity: 0.8,
    });
    this.guideRing = new Mesh(new RingGeometry(0.105, 0.125, 32), ringMat);
    this.guideRing.position.set(0, 1.2, -0.85);
    this.world.createTransformEntity(this.guideRing);

    // 2. "Organize Pillars" Button
    const btnTex = createButtonTexture(
      'Organize Pillars',
      'AI Sort',
      '#1e243d',
      '#121629',
      '#a855f7',
      420,
      140
    );
    const btnMaterials = buildRoundedCardMaterials(btnTex);
    const btnMesh = new Mesh(new BoxGeometry(0.225, 0.076, 0.016), btnMaterials);
    btnMesh.position.set(-0.145, 1.02, -0.82);

    this.world
      .createTransformEntity(btnMesh)
      .addComponent(SynthButton)
      .addComponent(RayInteractable);

    const btnAny = btnMesh as any;
    btnAny.addEventListener('pointerenter', () => {
      this.btnHovered = true;
      btnMaterials[4].emissive = new Color(0x3b1d5e);
    });
    btnAny.addEventListener('pointerleave', () => {
      this.btnHovered = false;
      btnMaterials[4].emissive = new Color(0x000000);
    });
    btnAny.addEventListener('pointerdown', () => this.organizeIntoPillars());
    btnAny.addEventListener('click', () => this.organizeIntoPillars());

    // 3. "Clear" Button
    const clearTex = createButtonTexture(
      'Clear',
      'Reset',
      '#2d1824',
      '#1a0e16',
      '#f43f5e',
      230,
      140
    );
    const clearMaterials = buildRoundedCardMaterials(clearTex);
    const clearMesh = new Mesh(new BoxGeometry(0.125, 0.076, 0.016), clearMaterials);
    clearMesh.position.set(0.05, 1.02, -0.82);

    this.world
      .createTransformEntity(clearMesh)
      .addComponent(ClearButton)
      .addComponent(RayInteractable);

    const clearAny = clearMesh as any;
    clearAny.addEventListener('pointerenter', () => {
      this.clearHovered = true;
      clearMaterials[4].emissive = new Color(0x5c1929);
    });
    clearAny.addEventListener('pointerleave', () => {
      this.clearHovered = false;
      clearMaterials[4].emissive = new Color(0x000000);
    });
    clearAny.addEventListener('pointerdown', () => this.clearBoard(true));
    clearAny.addEventListener('click', () => this.clearBoard(true));

    // 4. "Room" Backdrop Toggle Button (Switches between Clean Study Wall & Open Passthrough)
    const roomTex = createButtonTexture(
      'Room',
      'Backdrop',
      '#162a33',
      '#0e1a21',
      '#2dd4bf',
      230,
      140
    );
    const roomMaterials = buildRoundedCardMaterials(roomTex);
    this.roomBtnMesh = new Mesh(new BoxGeometry(0.125, 0.076, 0.016), roomMaterials);
    this.roomBtnMesh.position.set(0.195, 1.02, -0.82);

    this.world.createTransformEntity(this.roomBtnMesh).addComponent(RayInteractable);

    const roomAny = this.roomBtnMesh as any;
    let lastRoomClick = 0;
    const toggleRoomWalls = () => {
      const now = performance.now();
      if (now - lastRoomClick < 300) return;
      lastRoomClick = now;

      this.roomWallsVisible = !this.roomWallsVisible;
      for (const m of this.backdropMeshes) {
        m.visible = this.roomWallsVisible;
      }
      this.sfx.playTipToggle(this.roomWallsVisible);
    };

    roomAny.addEventListener('pointerenter', () => {
      this.roomBtnHovered = true;
      roomMaterials[4].emissive = new Color(0x134e4a);
    });
    roomAny.addEventListener('pointerleave', () => {
      this.roomBtnHovered = false;
      roomMaterials[4].emissive = new Color(0x000000);
    });
    roomAny.addEventListener('pointerdown', toggleRoomWalls);
    roomAny.addEventListener('click', toggleRoomWalls);

    // 5. Keyboard shortcuts in simulator
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.handleOrbActivate();
      } else if (e.code === 'Enter') {
        this.organizeIntoPillars();
      } else if (e.code === 'Backspace') {
        this.clearBoard(true);
      } else if (e.code === 'KeyB') {
        toggleRoomWalls();
      }
    });
  }

  private buildStudyEnvironment(): void {
    // A. Warm Oak Study Tabletop (surface at y = 0.78m, right below Voice Orb & Cards)
    const woodTex = createWoodTableTexture();
    const tableMat = new MeshStandardMaterial({
      map: woodTex,
      roughness: 0.52,
      metalness: 0.04,
    });
    const tableTop = new Mesh(new BoxGeometry(1.68, 0.036, 0.86), tableMat);
    tableTop.position.set(0, 0.762, -0.78);
    this.world.createTransformEntity(tableTop);

    // B. Charcoal Felt Desk Mat centered under the Voice Orb
    const matTex = createDeskMatTexture();
    const deskMatMaterial = new MeshStandardMaterial({
      map: matTex,
      roughness: 0.88,
      metalness: 0.02,
    });
    const deskMat = new Mesh(new BoxGeometry(0.9, 0.005, 0.44), deskMatMaterial);
    deskMat.position.set(0, 0.7825, -0.76);
    this.world.createTransformEntity(deskMat);

    // C. Four Matte-Black Steel Desk Legs
    const legMat = new MeshStandardMaterial({
      color: new Color(0x181b22),
      roughness: 0.45,
      metalness: 0.65,
    });
    const legPositions: [number, number][] = [
      [-0.76, -0.4],
      [0.76, -0.4],
      [-0.76, -1.16],
      [0.76, -1.16],
    ];
    for (const [lx, lz] of legPositions) {
      const leg = new Mesh(new BoxGeometry(0.042, 0.744, 0.042), legMat);
      leg.position.set(lx, 0.372, lz);
      this.world.createTransformEntity(leg);
    }

    // D. Clean Matte Study Nook Backdrop (replaces cluttered background behind cards)
    const wallTex = createStudyWallTexture();
    const wallMat = new MeshBasicMaterial({ map: wallTex, side: DoubleSide });

    const backWall = new Mesh(new PlaneGeometry(3.6, 2.5), wallMat);
    backWall.position.set(0, 1.25, -1.52);
    this.world.createTransformEntity(backWall);

    const leftWall = new Mesh(new PlaneGeometry(1.8, 2.5), wallMat);
    leftWall.position.set(-1.8, 1.25, -0.62);
    leftWall.rotation.y = Math.PI / 2;
    this.world.createTransformEntity(leftWall);

    const rightWall = new Mesh(new PlaneGeometry(1.8, 2.5), wallMat);
    rightWall.position.set(1.8, 1.25, -0.62);
    rightWall.rotation.y = -Math.PI / 2;
    this.world.createTransformEntity(rightWall);

    const floorRugMat = new MeshBasicMaterial({
      color: new Color(0x161922),
      side: DoubleSide,
    });
    const floorRug = new Mesh(new PlaneGeometry(3.6, 2.4), floorRugMat);
    floorRug.position.set(0, 0.002, -0.35);
    floorRug.rotation.x = -Math.PI / 2;
    this.world.createTransformEntity(floorRug);

    this.backdropMeshes = [backWall, leftWall, rightWall, floorRug];
  }

  private handleOrbActivate(): void {
    const now = performance.now();
    if (now - this.lastTriggerTime < 400) return;
    this.lastTriggerTime = now;

    this.guideRing.visible = false;
    this.triggerVoiceCapture();
  }

  private triggerVoiceCapture(): void {
    if (this.isListening || this.isThinking) return;
    this.isListening = true;
    this.sfx.playListenStart();

    this.orbMat.color.setHex(0xff2a85);
    this.orbMat.emissive.setHex(0xcc1166);
    this.orbMat.emissiveIntensity = 1.4;

    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      setTimeout(() => this.finishCapture(this.nextSample()), 900);
      return;
    }

    let settled = false;
    let recognition: any = null;

    const completeOnce = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        recognition?.abort();
      } catch {}
      this.finishCapture(text);
    };

    const watchdog = setTimeout(() => {
      completeOnce(this.nextSample());
    }, 5500);

    try {
      recognition = new SpeechRec();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: any) => {
        const spoken = event.results?.[0]?.[0]?.transcript;
        completeOnce(spoken && spoken.trim().length > 0 ? spoken : this.nextSample());
      };

      recognition.onerror = () => completeOnce(this.nextSample());
      recognition.onend = () => completeOnce(this.nextSample());

      recognition.start();
    } catch {
      completeOnce(this.nextSample());
    }
  }

  private nextSample(): string {
    const text = SAMPLE_BRAINDUMPS[this.sampleIndex % SAMPLE_BRAINDUMPS.length];
    this.sampleIndex++;
    return text;
  }

  private async finishCapture(transcript: string): Promise<void> {
    this.isListening = false;
    this.isThinking = true;

    this.orbMat.color.setHex(0xffb703);
    this.orbMat.emissive.setHex(0xd97706);
    this.orbMat.emissiveIntensity = 1.5;

    const ideas = await extractIdeasWithAI(transcript);

    this.isThinking = false;
    this.orbMat.color.setHex(0x00d2ff);
    this.orbMat.emissive.setHex(this.orbHovered ? 0x33ccff : 0x0077cc);
    this.orbMat.emissiveIntensity = this.orbHovered ? 1.4 : 0.9;

    this.appendCards(ideas);
  }

  private destroyRecord(rec: CardRecord): void {
    rec.entity.destroy();
    rec.tabEntity.destroy();
    rec.tipEntity.destroy();
  }

  private clearBoard(playSound = false): void {
    if (playSound && (this.cardRecords.length > 0 || this.headerEntities.length > 0)) {
      this.sfx.playClear();
    }
    for (const rec of this.cardRecords) this.destroyRecord(rec);
    for (const h of this.headerEntities) h.destroy();
    this.cardRecords = [];
    this.headerEntities = [];
    this.isOrganized = false;
  }

  private appendCards(ideas: ParsedIdea[]): void {
    const palette = [
      { bgTop: '#33192c', bgBottom: '#1c101b', accent: '#ff5e7e' },
      { bgTop: '#162d42', bgBottom: '#0e1b29', accent: '#38bdf8' },
      { bgTop: '#261e47', bgBottom: '#141029', accent: '#c084fc' },
    ];

    while (this.cardRecords.length + ideas.length > 9 && this.cardRecords.length > 0) {
      const oldest = this.cardRecords.shift();
      if (oldest) this.destroyRecord(oldest);
    }

    ideas.forEach((idea) => {
      const theme = palette[idea.priority];

      const { texture: cardTex, worldHeight } = createDynamicGlassCardTexture(
        idea.text,
        idea.tag,
        theme.bgTop,
        theme.bgBottom,
        theme.accent,
        CARD_WIDTH,
        33
      );
      const cardMaterials = buildRoundedCardMaterials(cardTex);
      const cardMesh = new Mesh(
        new BoxGeometry(CARD_WIDTH, worldHeight, 0.012),
        cardMaterials
      );
      cardMesh.position.set(0, 1.24, -0.85);

      const entity = this.world
        .createTransformEntity(cardMesh)
        .addComponent(IdeaCard, {
          priority: idea.priority,
          targetX: 0,
          targetY: 1.45,
          targetZ: -1.04,
          moving: 1,
        })
        .addComponent(RayInteractable)
        .addComponent(DistanceGrabbable);

      const tabMaterials = buildRoundedCardMaterials(createSideTabTexture(theme.accent, false));
      const tabMesh = new Mesh(new BoxGeometry(0.042, 0.068, 0.012), tabMaterials);
      tabMesh.position.set(0, 1.24, -0.85);

      const tabEntity = this.world
        .createTransformEntity(tabMesh)
        .addComponent(RayInteractable);

      const { texture: tipTex, worldHeight: tipHeight } = createDynamicGlassCardTexture(
        idea.tip,
        'AI Suggestion',
        '#1f2937',
        '#111827',
        '#fbbf24',
        TIP_WIDTH,
        28
      );
      const tipMaterials = buildRoundedCardMaterials(tipTex);
      const tipMesh = new Mesh(new BoxGeometry(TIP_WIDTH, tipHeight, 0.011), tipMaterials);
      tipMesh.visible = false;
      tipMesh.scale.setScalar(0.5);

      const tipEntity = this.world.createTransformEntity(tipMesh);

      const record: CardRecord = {
        entity,
        tabEntity,
        tipEntity,
        priority: idea.priority,
        height: worldHeight,
        tipOpen: false,
        tipProgress: 0,
        cardHovered: false,
        tabHovered: false,
        frontMat: cardMaterials[4],
        tabMat: tabMaterials[4],
      };

      const cardAny = cardMesh as any;
      cardAny.addEventListener('pointerenter', () => {
        record.cardHovered = true;
        record.frontMat.emissive = new Color(theme.accent);
        record.frontMat.emissiveIntensity = 0.16;
      });
      cardAny.addEventListener('pointerleave', () => {
        record.cardHovered = false;
        record.frontMat.emissive = new Color(0x000000);
        record.frontMat.emissiveIntensity = 0;
      });

      const tabAny = tabMesh as any;
      let lastTabClick = 0;
      const toggleTip = () => {
        const now = performance.now();
        if (now - lastTabClick < 300) return;
        lastTabClick = now;

        const nextState = !record.tipOpen;
        for (const other of this.cardRecords) {
          if (other !== record && other.tipOpen) {
            other.tipOpen = false;
            other.tabMat.map = createSideTabTexture(
              palette[other.priority].accent,
              false
            );
            other.tabMat.needsUpdate = true;
          }
        }

        record.tipOpen = nextState;
        record.tabMat.map = createSideTabTexture(theme.accent, nextState);
        record.tabMat.needsUpdate = true;
        this.sfx.playTipToggle(nextState);
      };

      tabAny.addEventListener('pointerenter', () => {
        record.tabHovered = true;
      });
      tabAny.addEventListener('pointerleave', () => {
        record.tabHovered = false;
      });
      tabAny.addEventListener('pointerdown', toggleTip);
      tabAny.addEventListener('click', toggleTip);

      this.cardRecords.push(record);
    });

    this.sfx.playCardSpawn();

    if (this.isOrganized) {
      this.organizeIntoPillars(false);
    } else {
      this.layoutArc();
    }
  }

  private layoutArc(): void {
    const cols = 3;
    const rowTopY: number[] = [1.62];

    const rowCount = Math.ceil(this.cardRecords.length / cols);
    for (let r = 0; r < rowCount; r++) {
      let maxH = 0.09;
      for (let c = 0; c < cols; c++) {
        const rec = this.cardRecords[r * cols + c];
        if (rec && rec.height > maxH) maxH = rec.height;
      }
      if (r + 1 < rowCount) {
        rowTopY[r + 1] = rowTopY[r] - maxH - 0.032;
      }
    }

    this.cardRecords.forEach((rec, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = Math.min(cols, this.cardRecords.length - row * cols);
      const angle = (col - (itemsInRow - 1) / 2) * 0.42;
      const radius = 1.06;

      rec.entity.setValue(IdeaCard, 'targetX', Math.sin(angle) * radius);
      rec.entity.setValue(IdeaCard, 'targetY', rowTopY[row] - rec.height / 2);
      rec.entity.setValue(IdeaCard, 'targetZ', -Math.cos(angle) * radius);
      rec.entity.setValue(IdeaCard, 'moving', 1);
    });
  }

  private organizeIntoPillars(playSound = true): void {
    if (this.cardRecords.length === 0) return;
    this.isOrganized = true;
    if (playSound) this.sfx.playOrganize();

    for (const h of this.headerEntities) h.destroy();
    this.headerEntities = [];

    const pillars = [
      { title: 'DO NOW', x: -0.44, color: '#ff5e7e', bgTop: '#33192c', bgBottom: '#1c101b' },
      { title: 'NEXT', x: 0, color: '#38bdf8', bgTop: '#162d42', bgBottom: '#0e1b29' },
      { title: 'PARK', x: 0.44, color: '#c084fc', bgTop: '#261e47', bgBottom: '#141029' },
    ];

    pillars.forEach((p) => {
      const tex = createButtonTexture(p.title, 'Pillar', p.bgTop, p.bgBottom, p.color, 420, 118);
      const headerMesh = new Mesh(
        new PlaneGeometry(0.32, 0.09),
        new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide })
      );
      headerMesh.position.set(p.x, 1.72, -1.04);
      headerMesh.lookAt(0, 1.45, 0);
      this.headerEntities.push(this.world.createTransformEntity(headerMesh));
    });

    const columnTopY = [1.64, 1.64, 1.64];
    for (const rec of this.cardRecords) {
      const p = rec.priority;
      const centerY = columnTopY[p] - rec.height / 2;
      columnTopY[p] -= rec.height + 0.028;

      rec.entity.setValue(IdeaCard, 'targetX', pillars[p].x);
      rec.entity.setValue(IdeaCard, 'targetY', centerY);
      rec.entity.setValue(IdeaCard, 'targetZ', -1.04);
      rec.entity.setValue(IdeaCard, 'moving', 1);
    }
  }

  update(delta: number, time: number): void {
    for (const orb of this.queries.orbs.entities) {
      const pulse =
        this.isListening || this.isThinking
          ? 1.2 + Math.sin(time * 12) * 0.14
          : this.orbHovered
            ? 1.15
            : 1.0;
      orb.object3D!.scale.setScalar(pulse);
      orb.object3D!.position.y = 1.2 + Math.sin(time * 2.2) * 0.012;
    }

    if (this.guideRing.visible) {
      const ringScale = 1 + Math.sin(time * 3.5) * 0.15;
      this.guideRing.scale.setScalar(ringScale);
    }

    for (const btn of this.queries.synthButtons.entities) {
      btn.object3D!.scale.setScalar(this.btnHovered ? 1.07 : 1.0);
    }

    for (const btn of this.queries.clearButtons.entities) {
      btn.object3D!.scale.setScalar(this.clearHovered ? 1.07 : 1.0);
    }

    if (this.roomBtnMesh) {
      this.roomBtnMesh.scale.setScalar(this.roomBtnHovered ? 1.07 : 1.0);
    }

    for (const rec of this.cardRecords) {
      const cardObj = rec.entity.object3D!;

      if (rec.entity.getValue(IdeaCard, 'moving') === 1) {
        const tx = rec.entity.getValue(IdeaCard, 'targetX')!;
        const ty = rec.entity.getValue(IdeaCard, 'targetY')!;
        const tz = rec.entity.getValue(IdeaCard, 'targetZ')!;

        cardObj.position.x += (tx - cardObj.position.x) * Math.min(1, delta * 8);
        cardObj.position.y += (ty - cardObj.position.y) * Math.min(1, delta * 8);
        cardObj.position.z += (tz - cardObj.position.z) * Math.min(1, delta * 8);
        cardObj.lookAt(0, 1.38, 0);

        if (
          Math.abs(tx - cardObj.position.x) < 0.004 &&
          Math.abs(ty - cardObj.position.y) < 0.004
        ) {
          rec.entity.setValue(IdeaCard, 'moving', 0);
        }
      }

      const targetScale = rec.cardHovered ? 1.03 : 1.0;
      const nextScale = cardObj.scale.x + (targetScale - cardObj.scale.x) * Math.min(1, delta * 12);
      cardObj.scale.setScalar(nextScale);

      const tabObj = rec.tabEntity.object3D!;
      this.tmpOffset.set(CARD_WIDTH / 2 + 0.023, 0, 0.003).applyQuaternion(cardObj.quaternion);
      tabObj.position.copy(cardObj.position).add(this.tmpOffset);
      tabObj.quaternion.copy(cardObj.quaternion);
      tabObj.scale.setScalar(rec.tabHovered ? 1.12 : 1.0);

      const targetProgress = rec.tipOpen ? 1 : 0;
      rec.tipProgress += (targetProgress - rec.tipProgress) * Math.min(1, delta * 11);

      const tipObj = rec.tipEntity.object3D!;
      if (rec.tipProgress > 0.02) {
        tipObj.visible = true;
        const slideX = CARD_WIDTH / 2 + 0.055 + (TIP_WIDTH / 2) * rec.tipProgress;
        const slideZ = 0.042 * rec.tipProgress;
        this.tmpOffset.set(slideX, 0, slideZ).applyQuaternion(cardObj.quaternion);
        tipObj.position.copy(cardObj.position).add(this.tmpOffset);

        this.tmpEuler.set(0, -0.22 * rec.tipProgress, 0);
        this.tmpQuat.setFromEuler(this.tmpEuler);
        tipObj.quaternion.copy(cardObj.quaternion).multiply(this.tmpQuat);

        const s = 0.55 + 0.45 * rec.tipProgress;
        tipObj.scale.setScalar(s);
      } else {
        tipObj.visible = false;
      }
    }
  }
}