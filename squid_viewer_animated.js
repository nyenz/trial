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

// Store references to animate specific parts
const tentacleMeshes = [];
const bodyMeshes = [];
const finMeshes = [];
const eyeMeshes = [];
const headMeshes = [];

partsSource.forEach((sp) => {
    const geo = makePartGeometry(sp.triIdx);
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
    
    // Categorize parts for animation
    const name = sp.name.toLowerCase();
    if (name.includes('eye')) {
        eyeMeshes.push(mesh);
    } else if (name.includes('fin') || name.includes('wing')) {
        finMeshes.push(mesh);
    } else if (name.includes('tentacle') || name.includes('arm')) {
        tentacleMeshes.push(mesh);
    } else if (name.includes('head') || name.includes('body') || name.includes('mantle')) {
        bodyMeshes.push(mesh);
        headMeshes.push(mesh);
    } else {
        // Default to body/tentacle based on position
        bodyMeshes.push(mesh);
    }
    
    squidGroup.add(mesh);
});

// If no specific parts found, treat all as body
if (tentacleMeshes.length === 0 && finMeshes.length === 0) {
    // Assume first few are body, rest are tentacles
    bodyMeshes.push(...squidGroup.children.slice(0, Math.min(3, squidGroup.children.length)));
    tentacleMeshes.push(...squidGroup.children.slice(3));
}

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

// ---- Animation functions ----
function animateSquid(deltaTime) {
    const t = time * swimSpeed;
    const intensity = animationIntensity;
    
    // Body undulation - sine wave motion along the body
    bodyMeshes.forEach((mesh, index) => {
        const phase = index * 0.3;
        mesh.rotation.z = Math.sin(t + phase) * 0.05 * intensity;
        mesh.rotation.x = Math.cos(t * 0.5 + phase) * 0.03 * intensity;
    });
    
    // Tentacle wave animation - flowing motion
    tentacleMeshes.forEach((mesh, index) => {
        const phase = index * 0.5;
        const waveFreq = 3 + index * 0.3;
        
        // Primary wave motion
        mesh.rotation.x = Math.sin(t * waveFreq + phase) * 0.15 * intensity;
        mesh.rotation.z = Math.cos(t * waveFreq * 0.7 + phase) * 0.1 * intensity;
        
        // Secondary curling motion
        const curlAmount = Math.sin(t * 2 + phase * 2) * 0.05 * intensity;
        mesh.rotation.y += curlAmount;
    });
    
    // Fin fluttering - rapid small movements
    finMeshes.forEach((mesh, index) => {
        const flutterSpeed = 8 + index;
        const flutterAmount = 0.3 * intensity;
        
        mesh.rotation.y = Math.sin(t * flutterSpeed) * flutterAmount;
        mesh.rotation.z = Math.cos(t * flutterSpeed * 0.5) * flutterAmount * 0.5;
    });
    
    // Eye movement - subtle tracking
    eyeMeshes.forEach((mesh) => {
        const trackAmount = 0.1 * intensity;
        mesh.rotation.x = Math.sin(t * 0.3) * trackAmount;
        mesh.rotation.y = Math.cos(t * 0.5) * trackAmount;
    });
    
    // Overall swimming motion - gentle up/down and side to side
    squidGroup.position.y = Math.sin(t * 0.5) * 0.2 * intensity;
    squidGroup.position.x = Math.sin(t * 0.3) * 0.15 * intensity;
    
    // Slight forward/backward bobbing
    squidGroup.position.z = Math.sin(t * 0.7) * 0.1 * intensity;
    
    // Gentle overall rotation as if turning
    squidGroup.rotation.y = Math.sin(t * 0.2) * 0.1;
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
    
    // Animate squid
    animateSquid(deltaTime);
    
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
