import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- Load split mesh data ----
async function loadMeshData() {
    const [meta, positions, normals, uvs, indices, refIds, normalOffsets, partIndices] = await Promise.all([
        fetch('mesh-meta.json').then(r => r.json()),
        fetch('positions.f32.bin').then(r => r.arrayBuffer()),
        fetch('normals.f32.bin').then(r => r.arrayBuffer()),
        fetch('uvs.f32.bin').then(r => r.arrayBuffer()),
        fetch('indices.u16.bin').then(r => r.arrayBuffer()),
        fetch('refids.u16.bin').then(r => r.arrayBuffer()),
        fetch('normaloffsets.f32.bin').then(r => r.arrayBuffer()),
        fetch('part-indices.u16.bin').then(r => r.arrayBuffer()),
    ]);

    return {
        meta,
        basePositions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint16Array(indices),
        refIDs: new Uint16Array(refIds),
        normalOffsets: new Float32Array(normalOffsets),
        partIndices: new Uint16Array(partIndices),
    };
}

const data = await loadMeshData();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x001a33, 0.02);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// ---- Lighting for underwater scene ----
const ambientLight = new THREE.AmbientLight(0x4080ff, 0.4);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xaaccff, 0.8);
dirLight.position.set(5, 10, 7.5);
dirLight.castShadow = true;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0x6699cc, 0.3);
fillLight.position.set(-5, 0, -5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0x88ccff, 0.2);
rimLight.position.set(0, -5, -5);
scene.add(rimLight);

// ---- Reconstruct vertex positions ----
const vertCount = data.basePositions.length / 3;
const procPositions = new Float32Array(data.basePositions.length);
for (let i = 0; i < vertCount; i++) {
    const offset = data.normalOffsets[i];
    procPositions[i * 3 + 0] = data.basePositions[i * 3 + 0] + data.normals[i * 3 + 0] * offset;
    procPositions[i * 3 + 1] = data.basePositions[i * 3 + 1] + data.normals[i * 3 + 1] * offset;
    procPositions[i * 3 + 2] = data.basePositions[i * 3 + 2] + data.normals[i * 3 + 2] * offset;
}

// ---- Create animated squid with body parts ----
const squidGroup = new THREE.Group();
scene.add(squidGroup);

let texture = null;
if (data.meta.textureDataUrl) {
    texture = new THREE.TextureLoader().load(data.meta.textureDataUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
}

function makePartGeometry(triIdx) {
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(triIdx, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(procPositions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    if (data.uvs.length) geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    return geo;
}

const partsSource = data.meta.parts && data.meta.parts.length
    ? data.meta.parts.map(p => ({
        color: p.color,
        visible: p.visible,
        triIdx: data.partIndices.subarray(p.triOffset, p.triOffset + p.triCount),
        uid: p.uid,
        name: p.name
    }))
    : [{ triIdx: data.indices, color: '#cccccc', visible: true }];

// Store references to animate specific parts - analyze by position and size
const mantleParts = [];      // Main body/mantle (largest parts at center)
const finParts = [];         // Fins (side parts)
const headParts = [];        // Head region
const armParts = [];         // Shorter arms near head
const tentacleParts = [];    // Longer tentacles
const eyeParts = [];         // Eyes

// Calculate bounding box for each part to determine its role
partsSource.forEach((sp, partIndex) => {
    const geo = makePartGeometry(sp.triIdx);
    geo.computeBoundingBox();
    const bbox = geo.boundingBox;
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    
    const matArgs = { 
        color: texture ? 0xffffff : sp.color, 
        side: THREE.DoubleSide,
        roughness: 0.4,
        metalness: 0.1
    };
    if (texture) matArgs.map = texture;
    const mat = new THREE.MeshStandardMaterial(matArgs);
    mat.wireframe = !!data.meta.savedWireframe;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = sp.visible !== false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    
    // Store original positions for animation reference
    mesh.userData.originalCenter = center.clone();
    mesh.userData.originalSize = size.clone();
    mesh.userData.partIndex = partIndex;
    mesh.userData.bbox = bbox;
    
    // Categorize based on position and size
    const yCenter = center.y;
    const xCenter = center.x;
    const zCenter = center.z;
    const volume = size.x * size.y * size.z;
    const isLarge = volume > 0.5;
    const isSmall = volume < 0.1;
    
    // Eyes are typically small and positioned forward/up
    if (sp.name.toLowerCase().includes('eye') || (isSmall && yCenter > 0.3 && Math.abs(xCenter) < 0.3)) {
        eyeParts.push(mesh);
    }
    // Fins are typically on the sides (large |x| values)
    else if (Math.abs(xCenter) > 0.4 && !isSmall) {
        finParts.push(mesh);
    }
    // Mantle/body is large and central
    else if (isLarge && Math.abs(xCenter) < 0.3 && yCenter < 0.2) {
        mantleParts.push(mesh);
    }
    // Head is central but smaller than mantle, towards front
    else if (!isSmall && Math.abs(xCenter) < 0.2 && yCenter > 0) {
        headParts.push(mesh);
    }
    // Arms and tentacles are smaller, extending outward
    else if (isSmall || (size.y > size.x && size.y > size.z)) {
        // Distinguish arms (shorter, closer to head) from tentacles (longer)
        if (size.length() < 0.8) {
            armParts.push(mesh);
        } else {
            tentacleParts.push(mesh);
        }
    }
    else {
        // Default to mantle
        mantleParts.push(mesh);
    }
    
    squidGroup.add(mesh);
});

// If categorization failed, use index-based approach
if (mantleParts.length === 0 && finParts.length === 0 && tentacleParts.length === 0) {
    // Assume: first 2 parts = mantle, next 2 = fins, rest = tentacles/arms
    const allMeshes = Array.from(squidGroup.children);
    mantleParts.push(...allMeshes.slice(0, Math.min(2, allMeshes.length)));
    finParts.push(...allMeshes.slice(2, Math.min(4, allMeshes.length)));
    tentacleParts.push(...allMeshes.slice(4, Math.min(10, allMeshes.length)));
    armParts.push(...allMeshes.slice(10, Math.min(15, allMeshes.length)));
    eyeParts.push(...allMeshes.slice(15));
}

console.log('Categorized parts:', {
    mantle: mantleParts.length,
    fins: finParts.length,
    head: headParts.length,
    arms: armParts.length,
    tentacles: tentacleParts.length,
    eyes: eyeParts.length
});

// ---- Animation state ----
const clock = new THREE.Clock();
let swimSpeed = 0.5;
let animationIntensity = 1.0;
let autoRotate = true;
let time = 0;

// ---- Controls ----
document.getElementById('speedSlider').addEventListener('input', (e) => {
    swimSpeed = parseFloat(e.target.value);
});

document.getElementById('intensitySlider').addEventListener('input', (e) => {
    animationIntensity = parseFloat(e.target.value);
});

document.getElementById('autoRotate').addEventListener('change', (e) => {
    autoRotate = e.target.checked;
});

// ---- Particle system for bubbles ----
const bubbleGeometry = new THREE.BufferGeometry();
const bubbleCount = 200;
const bubblePositions = new Float32Array(bubbleCount * 3);
const bubbleSizes = new Float32Array(bubbleCount);
const bubbleSpeeds = new Float32Array(bubbleCount);

for (let i = 0; i < bubbleCount; i++) {
    bubblePositions[i * 3] = (Math.random() - 0.5) * 20;
    bubblePositions[i * 3 + 1] = Math.random() * 20 - 10;
    bubblePositions[i * 3 + 2] = (Math.random() - 0.5) * 20;
    bubbleSizes[i] = Math.random() * 0.05 + 0.01;
    bubbleSpeeds[i] = Math.random() * 0.5 + 0.2;
}

bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(bubblePositions, 3));
bubbleGeometry.setAttribute('size', new THREE.BufferAttribute(bubbleSizes, 1));

const bubbleMaterial = new THREE.PointsMaterial({
    color: 0xaaddff,
    transparent: true,
    opacity: 0.6,
    size: 0.05,
    sizeAttenuation: true
});

const bubbles = new THREE.Points(bubbleGeometry, bubbleMaterial);
scene.add(bubbles);

// ---- Advanced Animation functions ----

// Animate mantle (body) with realistic contraction/expansion for jet propulsion
function animateMantle(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    // Mantle breathing/contraction motion (jet propulsion simulation)
    mantleParts.forEach((mesh, index) => {
        const phase = index * 0.2;
        const breatheSpeed = 1.5;
        
        // Subtle expansion and contraction along the body axis
        const scaleBase = 1.0;
        const scaleX = scaleBase + Math.sin(t * breatheSpeed + phase) * 0.02 * intensity;
        const scaleY = scaleBase + Math.cos(t * breatheSpeed * 0.8 + phase) * 0.015 * intensity;
        const scaleZ = scaleBase + Math.sin(t * breatheSpeed * 0.6 + phase) * 0.025 * intensity;
        
        mesh.scale.set(scaleX, scaleY, scaleZ);
        
        // Gentle undulation wave traveling through mantle
        const undulateAmount = Math.sin(t * 2 + phase * 3) * 0.03 * intensity;
        mesh.rotation.z = undulateAmount;
        mesh.rotation.x = Math.cos(t * 1.5 + phase) * 0.02 * intensity;
    });
}

// Animate fins with realistic fluttering motion
function animateFins(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    finParts.forEach((mesh, index) => {
        const isLeftFin = mesh.userData.originalCenter.x < 0;
        const finSide = isLeftFin ? -1 : 1;
        const phase = index * 0.3;
        
        // Primary flutter motion - rapid small oscillations
        const flutterSpeed = 10 + index * 0.5;
        const flutterAmount = 0.4 * intensity;
        
        // Fin waves from base to tip
        mesh.rotation.y = Math.sin(t * flutterSpeed + phase) * flutterAmount * finSide;
        mesh.rotation.z = Math.cos(t * flutterSpeed * 0.7 + phase) * flutterAmount * 0.3;
        mesh.rotation.x = Math.sin(t * flutterSpeed * 0.5 + phase) * flutterAmount * 0.2;
        
        // Add subtle figure-8 motion for more natural swimming
        const figure8 = Math.sin(t * flutterSpeed * 1.5) * Math.cos(t * flutterSpeed * 0.8);
        mesh.rotation.y += figure8 * 0.1 * intensity;
    });
}

// Animate head with subtle tracking movements
function animateHead(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    headParts.forEach((mesh, index) => {
        const phase = index * 0.4;
        
        // Head follows body motion with slight delay
        mesh.rotation.z = Math.sin(t * 1.2 + phase) * 0.04 * intensity;
        mesh.rotation.x = Math.cos(t * 0.8 + phase) * 0.03 * intensity;
        mesh.rotation.y = Math.sin(t * 0.6 + phase) * 0.02 * intensity;
    });
}

// Animate arms (shorter appendages) with flowing motion
function animateArms(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    armParts.forEach((mesh, index) => {
        const phase = index * 0.6;
        const armFreq = 2.5 + index * 0.4;
        
        // Arms flow in coordinated wave patterns
        mesh.rotation.x = Math.sin(t * armFreq + phase) * 0.12 * intensity;
        mesh.rotation.z = Math.cos(t * armFreq * 0.8 + phase) * 0.08 * intensity;
        mesh.rotation.y = Math.sin(t * armFreq * 1.2 + phase * 1.5) * 0.06 * intensity;
        
        // Add curling motion at tips
        const curlPhase = phase * 2;
        mesh.rotation.y += Math.sin(t * 3 + curlPhase) * 0.04 * intensity;
    });
}

// Animate tentacles (longer appendages) with elegant flowing motion
function animateTentacles(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    tentacleParts.forEach((mesh, index) => {
        const phase = index * 0.5;
        const tentacleFreq = 1.8 + index * 0.3;
        
        // Primary flowing motion - longer wavelength than arms
        mesh.rotation.x = Math.sin(t * tentacleFreq + phase) * 0.18 * intensity;
        mesh.rotation.z = Math.cos(t * tentacleFreq * 0.7 + phase) * 0.14 * intensity;
        
        // Secondary spiral/curling motion
        const spiralPhase = phase * 1.8;
        mesh.rotation.y = Math.sin(t * tentacleFreq * 1.5 + spiralPhase) * 0.1 * intensity;
        
        // Tertiary gentle twist
        const twistAmount = Math.cos(t * 2.5 + phase * 2.5) * 0.05 * intensity;
        mesh.rotation.z += twistAmount;
    });
}

// Animate eyes with subtle tracking movement
function animateEyes(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    eyeParts.forEach((mesh, index) => {
        const isLeftEye = mesh.userData.originalCenter.x < 0;
        const eyeSide = isLeftEye ? -1 : 1;
        
        // Eyes track imaginary point with smooth motion
        const trackSpeed = 0.8;
        const trackAmount = 0.08 * intensity;
        
        mesh.rotation.x = Math.sin(t * trackSpeed) * trackAmount;
        mesh.rotation.y = Math.cos(t * trackSpeed * 0.7) * trackAmount * eyeSide;
        
        // Subtle independent movement for realism
        const microMovement = Math.sin(t * 5 + index * 2) * 0.02 * intensity;
        mesh.rotation.z = microMovement;
    });
}

// Overall swimming motion - whole body movement through water
function animateSwimmingMotion(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    // Gentle helical swimming path
    squidGroup.position.y = Math.sin(t * 0.4) * 0.25 * intensity;
    squidGroup.position.x = Math.sin(t * 0.35) * 0.2 * intensity;
    squidGroup.position.z = Math.sin(t * 0.5) * 0.15 * intensity;
    
    // Body orientation follows swimming direction
    squidGroup.rotation.y = Math.sin(t * 0.25) * 0.15;
    squidGroup.rotation.x = Math.cos(t * 0.3) * 0.08 * intensity;
    squidGroup.rotation.z = Math.sin(t * 0.2) * 0.05 * intensity;
    
    // Simulate jet propulsion pulses
    const pulseSpeed = 2.0;
    const pulseAmount = Math.sin(t * pulseSpeed) * 0.02 * intensity;
    squidGroup.scale.setScalar(1.0 + pulseAmount);
}

function updateBubbles(deltaTime) {
    const positions = bubbles.geometry.attributes.position.array;
    const speeds = bubbleSpeeds;
    
    for (let i = 0; i < bubbleCount; i++) {
        positions[i * 3 + 1] += speeds[i] * deltaTime * (0.5 + swimSpeed * 0.5);
        
        // Reset bubble when it reaches the top
        if (positions[i * 3 + 1] > 10) {
            positions[i * 3 + 1] = -10;
            positions[i * 3] = (Math.random() - 0.5) * 20;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
        }
    }
    
    bubbles.geometry.attributes.position.needsUpdate = true;
}

// ---- Render loop ----
renderer.setAnimationLoop(() => {
    const deltaTime = clock.getDelta();
    time += deltaTime;
    
    // Animate all body parts
    animateMantle(deltaTime);
    animateFins(deltaTime);
    animateHead(deltaTime);
    animateArms(deltaTime);
    animateTentacles(deltaTime);
    animateEyes(deltaTime);
    animateSwimmingMotion(deltaTime);
    
    // Update bubbles
    updateBubbles(deltaTime);
    
    // Auto camera rotation
    if (autoRotate) {
        const camAngle = time * 0.1;
        camera.position.x = Math.sin(camAngle) * 3;
        camera.position.z = Math.cos(camAngle) * 3;
        camera.position.y = Math.sin(camAngle * 0.5) * 0.5;
        camera.lookAt(squidGroup.position);
    }
    
    controls.update();
    renderer.render(scene, camera);
});

// ---- Window resize ----
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
