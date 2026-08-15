import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- Load split mesh data (small binary buffers instead of one giant JSON blob) ----
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
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 3);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 7.5);
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0xddeeff, 0.4);
fillLight.position.set(-5, 0, -5);
scene.add(fillLight);

// ---- Reconstruct vertex positions (same procedural offset as the original file) ----
const vertCount = data.basePositions.length / 3;
const procPositions = new Float32Array(data.basePositions.length);
for (let i = 0; i < vertCount; i++) {
    const offset = data.normalOffsets[i];
    procPositions[i * 3 + 0] = data.basePositions[i * 3 + 0] + data.normals[i * 3 + 0] * offset;
    procPositions[i * 3 + 1] = data.basePositions[i * 3 + 1] + data.normals[i * 3 + 1] * offset;
    procPositions[i * 3 + 2] = data.basePositions[i * 3 + 2] + data.normals[i * 3 + 2] * offset;
}

// ---- Build one mesh per saved part (falls back to the whole mesh as one part if none saved) ----
const partsGroup = new THREE.Group();
scene.add(partsGroup);

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
    }))
    : [{ triIdx: data.indices, color: '#cccccc', visible: true }];

partsSource.forEach((sp) => {
    const geo = makePartGeometry(sp.triIdx);
    const matArgs = { color: texture ? 0xffffff : sp.color, side: THREE.DoubleSide };
    if (texture) matArgs.map = texture;
    const mat = new THREE.MeshStandardMaterial(matArgs);
    mat.wireframe = !!data.meta.savedWireframe;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = sp.visible !== false;
    partsGroup.add(mesh);
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
});
