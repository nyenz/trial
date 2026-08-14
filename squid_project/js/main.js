<script type="module">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const data = JSON.parse(document.getElementById('mesh-data').textContent);

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
        procPositions[i*3+0] = data.basePositions[i*3+0] + data.normals[i*3+0] * offset;
        procPositions[i*3+1] = data.basePositions[i*3+1] + data.normals[i*3+1] * offset;
        procPositions[i*3+2] = data.basePositions[i*3+2] + data.normals[i*3+2] * offset;
    }

    // ---- Overall bounds, used to work out the squid's long axis for the swim animation ----
    const bbMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const bbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < vertCount; i++) {
        const x = procPositions[i*3], y = procPositions[i*3+1], z = procPositions[i*3+2];
        if (x < bbMin.x) bbMin.x = x; if (y < bbMin.y) bbMin.y = y; if (z < bbMin.z) bbMin.z = z;
        if (x > bbMax.x) bbMax.x = x; if (y > bbMax.y) bbMax.y = y; if (z > bbMax.z) bbMax.z = z;
    }
    const bodyCenter = new THREE.Vector3().addVectors(bbMin, bbMax).multiplyScalar(0.5);
    const bodyExtent = new THREE.Vector3().subVectors(bbMax, bbMin);
    let axisIdx = 0;
    if (bodyExtent.y >= bodyExtent.x && bodyExtent.y >= bodyExtent.z) axisIdx = 1;
    else if (bodyExtent.z >= bodyExtent.x && bodyExtent.z >= bodyExtent.y) axisIdx = 2;
    const axisLen = bodyExtent.getComponent(axisIdx) || 1;

    // squidRoot drifts/bobs as a whole; partsGroup holds the individually-animated parts
    const squidRoot = new THREE.Group();
    scene.add(squidRoot);
    const partsGroup = new THREE.Group();
    squidRoot.add(partsGroup);

    let texture = null;
    if (data.textureDataUrl) {
        texture = new THREE.TextureLoader().load(data.textureDataUrl);
        texture.colorSpace = THREE.SRGBColorSpace;
    }

    // Each part gets its own pivot-relative geometry so it can rotate/sway
    // in place. Crucially the pivot is the point where the part actually
    // *touches its neighbour* (found by nearest-position matching, since the
    // pieces are separate meshes that meet at the seam rather than sharing
    // vertex indices) - not the part's centroid. Rotating about that seam
    // point is what keeps an arm/tentacle/fin visually attached while it
    // swings, instead of the whole part translating away from it.
    function computeCentroid(triIdx) {
        const seen = new Set();
        const c = new THREE.Vector3();
        for (let i = 0; i < triIdx.length; i++) {
            const idx = triIdx[i];
            if (seen.has(idx)) continue;
            seen.add(idx);
            c.x += procPositions[idx*3];
            c.y += procPositions[idx*3+1];
            c.z += procPositions[idx*3+2];
        }
        const n = seen.size || 1;
        return c.multiplyScalar(1 / n);
    }

    const partsSource = data.savedParts && data.savedParts.length
        ? data.savedParts
        : [{ uid: 'p0', name: 'Squid', triIdx: data.indices, color: '#cccccc', visible: true }];

    // ---- Merge known multi-segment arms into single continuous parts ----
    // Part 3 + Part 15 and Part 4 + Part 16 are each really just one arm
    // that got exported as two separately-pivoting segments. Leaving them
    // as two parts means two separate attachment points, two separate
    // bend/sway nodes, and two independent tapered-bend shaders - so even
    // once the seam is closed, the arm still visibly bends in two places
    // instead of moving as one continuous whip. Merging their triangle
    // indices into a single part (they already share the same vertex/
    // position buffer, so this is just a concatenation) makes each pair a
    // single mesh with a single pivot and a single bend animation, matching
    // real squid anatomy: one continuous arm per attachment point.
    // Same reasoning applies to the fins: Part 13 + Part 17 are one fin,
    // Part 14 + Part 18 are the other, each split into two segments in the
    // export. Merge those too so each fin is one continuous surface with a
    // single pivot, ready for its own (non-arm) flapping physics.
    const ARM_MERGES = [
        { keepUid: 'p2', mergeUid: 'p14', name: 'Arm (Part 3 + 15)' },   // Part 3 + Part 15
        { keepUid: 'p3', mergeUid: 'p15', name: 'Arm (Part 4 + 16)' },   // Part 4 + Part 16
        { keepUid: 'p12', mergeUid: 'p16', name: 'Fin (Part 13 + 17)' }, // Part 13 + Part 17
        { keepUid: 'p13', mergeUid: 'p17', name: 'Fin (Part 14 + 18)' }  // Part 14 + Part 18
    ];
    const FIN_UIDS = new Set(['p12', 'p13']); // final (merged) uids that are fins, used later for fin-specific physics
    ARM_MERGES.forEach(({ keepUid, mergeUid, name }) => {
        const keep = partsSource.find(sp => (sp.uid || 'p0') === keepUid);
        const mergeIdx = partsSource.findIndex(sp => (sp.uid || 'p0') === mergeUid);
        if (keep && mergeIdx !== -1) {
            const merge = partsSource[mergeIdx];
            keep.triIdx = keep.triIdx.concat(merge.triIdx);
            keep.name = name;
            keep.visible = keep.visible !== false && merge.visible !== false;
            partsSource.splice(mergeIdx, 1);
        }
    });

    // ---- Animation library ----
    // Each entry is one selectable "layer" of motion. Multiple layers on the
    // same category (fins / mantle) can be enabled at once and are simply
    // summed together each frame, so e.g. a fin can flap AND ripple AND fold
    // with speed simultaneously. Real squid behaviours these are modelled on:
    //   Fins  - continuous rippling flap for steering, a faster fine-ripple
    //           for micro-stabilization while hovering, and folding flatter
    //           against the mantle at speed (drag reduction).
    //   Mantle - the rhythmic jet-propulsion pulse, a gentle idle drift/tilt
    //           while hovering, and a secondary body ripple layered on the
    //           main pulse (visible in real squid as a wave along the mantle).
    const FIN_ANIMATIONS = {
        finWave: {
            label: 'Wave Flap',
            desc: 'Continuous travelling-wave flap along the fin, used for steering - the main fin motion.',
            params: [
                { key: 'speed', label: 'Speed', min: 0.5, max: 8, step: 0.1, default: 3.4 },
                { key: 'amplitude', label: 'Amplitude', min: 0, max: 0.4, step: 0.01, default: 0.16 }
            ],
            compute(p, ctx, v) {
                const speedDamp = 1 / (1 + Math.abs(ctx.swimVelocity) * 1.6);
                return Math.sin(ctx.simTime * v.speed + p.wavePhase) * v.amplitude * speedDamp
                     + Math.sin(ctx.simTime * v.speed * 2.1 + p.wavePhase + 1.1) * v.amplitude * 0.3 * speedDamp;
            }
        },
        finStabilize: {
            label: 'Stabilize Ripple',
            desc: 'Small, fast corrective flutter real fins use to hold position while hovering.',
            params: [
                { key: 'speed', label: 'Speed', min: 2, max: 14, step: 0.2, default: 7.5 },
                { key: 'amplitude', label: 'Amplitude', min: 0, max: 0.15, step: 0.005, default: 0.035 }
            ],
            compute(p, ctx, v) {
                return Math.sin(ctx.simTime * v.speed + p.wavePhase * 2.3 + 0.6) * v.amplitude;
            }
        },
        finFold: {
            label: 'Speed Fold',
            desc: 'Fin folds flatter against the mantle as forward speed increases, cutting drag when jetting.',
            params: [
                { key: 'strength', label: 'Strength', min: 0, max: 1.5, step: 0.05, default: 0.55 }
            ],
            compute(p, ctx, v) {
                return -ctx.swimVelocity * v.strength * 0.4;
            }
        }
    };

    const MANTLE_ANIMATIONS = {
        mantleJet: {
            label: 'Jet Pulse',
            desc: 'The main rhythmic contraction/expansion that powers jet propulsion.',
            params: [
                { key: 'speed', label: 'Speed', min: 0.4, max: 4, step: 0.1, default: 1.6 },
                { key: 'strength', label: 'Strength', min: 0, max: 0.12, step: 0.005, default: 0.055 }
            ],
            compute(ctx, v) {
                const squeeze = Math.pow(Math.max(0, Math.sin(ctx.simTime * v.speed)), 2);
                return { squeeze, scaleAxis: -v.strength * squeeze, scaleOther: v.strength * 0.36 * squeeze };
            }
        },
        mantleSway: {
            label: 'Idle Sway',
            desc: 'Gentle drifting tilt while hovering, like a resting squid holding station.',
            params: [
                { key: 'speed', label: 'Speed', min: 0.1, max: 1.2, step: 0.05, default: 0.3 },
                { key: 'amplitude', label: 'Amplitude', min: 0, max: 0.1, step: 0.005, default: 0.035 }
            ],
            compute(ctx, v) {
                return {
                    rotZ: Math.sin(ctx.simTime * v.speed) * v.amplitude,
                    rotX: Math.sin(ctx.simTime * v.speed * 0.8 + 1.1) * v.amplitude * 0.7
                };
            }
        },
        mantleRipple: {
            label: 'Body Ripple',
            desc: 'A subtle secondary wave along the mantle, layered on top of the main jet pulse.',
            params: [
                { key: 'speed', label: 'Speed', min: 0.5, max: 5, step: 0.1, default: 2.2 },
                { key: 'amplitude', label: 'Amplitude', min: 0, max: 0.04, step: 0.002, default: 0.015 }
            ],
            compute(ctx, v) {
                const r = Math.sin(ctx.simTime * v.speed) * v.amplitude;
                return { scaleAxis: -r, scaleOther: r * 0.5 };
            }
        }
    };

    // Arm/tentacle animation configurations - more natural trailing motion
    const ARM_ANIMATION_PARAMS = {
        trailDrag: 0.85,           // How much arms trail behind during movement
        baseOscillation: 0.9,      // Base frequency of arm swaying
        tipCurlAmount: 0.4,        // How much the tips curl inward
        tipCurlSpeed: 1.8,         // Speed of tip curling motion
        lateralSpread: 0.25,       // Side-to-side spread of arms
        verticalLag: 0.6           // Vertical lag relative to body motion
    };

    // Compute natural arm/tentacle animation with trailing, curling motion
    function computeArmAnimation(p, time, velocity) {
        const params = ARM_ANIMATION_PARAMS;
        // Base swaying motion that trails behind body movement
        const trailFactor = 1.0 - Math.min(Math.abs(velocity) * params.trailDrag, 0.8);
        const baseFreq = params.baseOscillation * trailFactor;
        const baseSway = Math.sin(time * baseFreq + p.wavePhase * 1.4) * p.swingAmp;
        // Secondary oscillation for more organic movement
        const secondarySway = Math.sin(time * baseFreq * 0.7 + p.wavePhase * 0.9 + 1.5) * p.swingAmp * 0.35;
        // Tip curling effect - longer parts curl more at their tips
        const tipCurl = Math.sin(time * params.tipCurlSpeed + p.wavePhase * 2.0) * params.tipCurlAmount * (p.reachLen / 1.5);
        // Lateral spread based on position around the body
        const lateralSpread = Math.cos(p.wavePhase) * params.lateralSpread * p.swingAmp * 0.5;
        // Combine all components
        return baseSway + secondarySway + tipCurl + lateralSpread;
    }


    function builtinAnimConfig(defs) {
        const enabled = {}, params = {};
        Object.keys(defs).forEach(id => {
            params[id] = {};
            defs[id].params.forEach(p => { params[id][p.key] = p.default; });
        });
        return { enabled, params };
    }

    // Sensible built-in defaults matching the original single-animation behaviour.
    const DEFAULT_FIN_CONFIG = builtinAnimConfig(FIN_ANIMATIONS);
    DEFAULT_FIN_CONFIG.enabled.finWave = true;
    const DEFAULT_MANTLE_CONFIG = builtinAnimConfig(MANTLE_ANIMATIONS);
    DEFAULT_MANTLE_CONFIG.enabled.mantleJet = true;
    DEFAULT_MANTLE_CONFIG.enabled.mantleSway = true;

    function cloneAnimConfig(cfg) { return JSON.parse(JSON.stringify(cfg)); }

    const ANIM_STORAGE_KEY = 'squidViewer.animDefaults.v1';
    function loadStoredDefaults() {
        try {
            const raw = localStorage.getItem(ANIM_STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }
    function saveStoredDefault(category, cfg) {
        const all = loadStoredDefaults();
        all[category] = cfg;
        try { localStorage.setItem(ANIM_STORAGE_KEY, JSON.stringify(all)); } catch (e) { /* ignore quota errors */ }
    }
    function getDefaultConfig(category) {
        const stored = loadStoredDefaults();
        if (stored[category]) return cloneAnimConfig(stored[category]);
        return cloneAnimConfig(category === 'fin' ? DEFAULT_FIN_CONFIG : DEFAULT_MANTLE_CONFIG);
    }

    const ROOT_UID = 'p0';
    const rootDef = partsSource.find(sp => (sp.uid || 'p0') === ROOT_UID) || partsSource[0];
    const rootPivotEarly = computeCentroid(rootDef.triIdx);

    // ---- Spatial hashing helpers, used to find where one set of vertices
    // touches another (their coincident/near-coincident boundary points) ----
    const CELL = 0.03;
    const cellKey = (x, y, z) => Math.round(x / CELL) + '_' + Math.round(y / CELL) + '_' + Math.round(z / CELL);

    function buildVertexGrid(uniqueIdx) {
        const grid = new Map();
        for (let i = 0; i < uniqueIdx.length; i++) {
            const idx = uniqueIdx[i];
            const k = cellKey(procPositions[idx*3], procPositions[idx*3+1], procPositions[idx*3+2]);
            let arr = grid.get(k);
            if (!arr) { arr = []; grid.set(k, arr); }
            arr.push(idx);
        }
        return grid;
    }

    function nearestDistToGrid(grid, x, y, z) {
        const cx = Math.round(x / CELL), cy = Math.round(y / CELL), cz = Math.round(z / CELL);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const arr = grid.get((cx+dx) + '_' + (cy+dy) + '_' + (cz+dz));
            if (!arr) continue;
            for (const idx of arr) {
                const ddx = procPositions[idx*3]-x, ddy = procPositions[idx*3+1]-y, ddz = procPositions[idx*3+2]-z;
                const d = ddx*ddx + ddy*ddy + ddz*ddz;
                if (d < best) best = d;
            }
        }
        return Math.sqrt(best);
    }

    // Returns the attachment point (where this part meets `parentGrid`) and its
    // "tip" (farthest own vertex from that point, i.e. how it reaches away
    // from its neighbour) so we know both where to pivot and which way it extends.
    function computeAttachment(triIdx, parentGrid) {
        const uniqueIdx = [...new Set(triIdx)];
        const dists = new Array(uniqueIdx.length);
        let minDist = Infinity;
        for (let i = 0; i < uniqueIdx.length; i++) {
            const idx = uniqueIdx[i];
            const d = nearestDistToGrid(parentGrid, procPositions[idx*3], procPositions[idx*3+1], procPositions[idx*3+2]);
            dists[i] = d;
            if (d < minDist) minDist = d;
        }
        const threshold = Math.max(minDist * 1.5, minDist + 0.02, 0.01);
        const attach = new THREE.Vector3();
        let count = 0;
        for (let i = 0; i < uniqueIdx.length; i++) {
            if (dists[i] <= threshold) {
                const idx = uniqueIdx[i];
                attach.x += procPositions[idx*3]; attach.y += procPositions[idx*3+1]; attach.z += procPositions[idx*3+2];
                count++;
            }
        }
        if (count > 0) attach.multiplyScalar(1 / count);
        else attach.set(procPositions[uniqueIdx[0]*3], procPositions[uniqueIdx[0]*3+1], procPositions[uniqueIdx[0]*3+2]);

        let farDist2 = -1, farIdx = uniqueIdx[0];
        for (let i = 0; i < uniqueIdx.length; i++) {
            const idx = uniqueIdx[i];
            const dx = procPositions[idx*3]-attach.x, dy = procPositions[idx*3+1]-attach.y, dz = procPositions[idx*3+2]-attach.z;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 > farDist2) { farDist2 = d2; farIdx = idx; }
        }
        const tip = new THREE.Vector3(procPositions[farIdx*3], procPositions[farIdx*3+1], procPositions[farIdx*3+2]);
        return { attach, tip };
    }

    function makePartGeometry(triIdx, pivot) {
        const localPos = new Float32Array(procPositions.length);
        for (let i = 0; i < vertCount; i++) {
            localPos[i*3]   = procPositions[i*3]   - pivot.x;
            localPos[i*3+1] = procPositions[i*3+1] - pivot.y;
            localPos[i*3+2] = procPositions[i*3+2] - pivot.z;
        }
        const geo = new THREE.BufferGeometry();
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(triIdx), 1));
        geo.setAttribute('position', new THREE.BufferAttribute(localPos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(data.normals), 3));
        if (data.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
        return geo;
    }

    const WORLD_UP = new THREE.Vector3(0, 1, 0);

    // ---- Build a parent/child skeleton across ALL parts (not just against
    // the mantle). Multi-segment appendages - e.g. an arm modelled as several
    // separate colour-coded pieces - are extremely common in this data, and
    // each piece only truly touches ONE neighbour (either the mantle, or the
    // segment before it). Attaching every part to "whichever mantle vertex
    // happens to be nearest" is what caused a downstream segment to pivot
    // around the wrong point and visibly separate from the segment it's
    // actually resting on. Instead we grow a spanning tree outward from the
    // mantle (root), always attaching the next-closest unassigned part to
    // whichever already-assigned part (root or otherwise) it is nearest to -
    // the same idea as Prim's minimum-spanning-tree algorithm. That gives
    // every part a true physical parent, so a multi-piece arm forms one
    // continuous chain instead of several independently-pivoting islands.
    const rootUnique = [...new Set(rootDef.triIdx)];
    const rootGrid = buildVertexGrid(rootUnique);

    const nonRootDefs = partsSource
        .filter(sp => (sp.uid || 'p0') !== ROOT_UID)
        .map(sp => {
            const uniqueIdx = [...new Set(sp.triIdx)];
            return { uid: sp.uid, sp, uniqueIdx, grid: buildVertexGrid(uniqueIdx) };
        });

    const grids = new Map();       // uid -> grid of ONLY that part's own vertices
    grids.set(ROOT_UID, rootGrid);
    const parentOf = new Map();    // uid -> parent uid (root or another part)
    const assignOrder = [];        // topological order: parent always appears before child

    const remaining = new Map(nonRootDefs.map(d => [d.uid, d]));
    const best = new Map();        // uid -> { dist, parentUid }

    function relaxAgainst(newUid, newGrid) {
        remaining.forEach((d, uid) => {
            let bestEntry = best.get(uid);
            let localBest = bestEntry ? bestEntry.dist : Infinity;
            for (let i = 0; i < d.uniqueIdx.length; i++) {
                const idx = d.uniqueIdx[i];
                const dist = nearestDistToGrid(newGrid, procPositions[idx*3], procPositions[idx*3+1], procPositions[idx*3+2]);
                if (dist < localBest) localBest = dist;
            }
            if (!bestEntry || localBest < bestEntry.dist) {
                best.set(uid, { dist: localBest, parentUid: newUid });
            }
        });
    }
    relaxAgainst(ROOT_UID, rootGrid);

    while (remaining.size) {
        let chosenUid = null, chosenDist = Infinity;
        remaining.forEach((d, uid) => {
            const b = best.get(uid);
            if (b && b.dist < chosenDist) { chosenDist = b.dist; chosenUid = uid; }
        });
        if (chosenUid === null) { // disconnected leftovers (shouldn't normally happen) - attach to root
            chosenUid = remaining.keys().next().value;
            best.set(chosenUid, { dist: Infinity, parentUid: ROOT_UID });
        }
        const chosen = remaining.get(chosenUid);
        parentOf.set(chosenUid, best.get(chosenUid).parentUid);
        assignOrder.push(chosenUid);
        grids.set(chosenUid, chosen.grid);
        remaining.delete(chosenUid);
        relaxAgainst(chosenUid, chosen.grid);
    }

    // Debug aid: dump the attachment tree the MST step above computed, so a
    // mis-attached segment (e.g. an arm piece that latched onto a
    // neighbouring arm instead of its true parent) is visible in devtools
    // without having to click through every part by hand.
    console.groupCollapsed('[squid] part attachment tree (parentUid, distance)');
    assignOrder.forEach(uid => {
        const sp = partsSource.find(s => (s.uid || '') === uid);
        const parentUid = parentOf.get(uid);
        const parentSp = partsSource.find(s => (s.uid || '') === parentUid);
        const dist = best.get(uid) ? best.get(uid).dist : null;
        console.log(
            (sp && sp.name) || uid, '→ parent:', (parentSp && parentSp.name) || parentUid,
            dist !== null ? `(seam gap ${dist.toFixed(4)})` : ''
        );
    });
    console.groupEnd();

    // uid -> animation/selection record
    const partsByUid = new Map();

    function addPart(sp, parentUidForThis) {
        const uid = sp.uid;
        const isRoot = uid === ROOT_UID;
        const isEyes = (sp.name || '').trim().toLowerCase() === 'eyes';
        const isFin = FIN_UIDS.has(uid);

        let pivot, reachDir, reachLen;
        if (isRoot) {
            pivot = rootPivotEarly.clone();
            reachDir = WORLD_UP.clone();
            reachLen = 0;
        } else {
            const parentGrid = grids.get(parentUidForThis);
            const { attach, tip } = computeAttachment(sp.triIdx, parentGrid);
            pivot = attach;
            const diff = new THREE.Vector3().subVectors(tip, attach);
            reachLen = diff.length();
            reachDir = reachLen > 1e-5 ? diff.normalize() : new THREE.Vector3(0, -1, 0);
        }

        const geo = makePartGeometry(sp.triIdx, pivot);
        // Render every part in one shared skin tone (the mantle's own
        // colour) rather than each part's individual debug-swatch colour.
        // The per-part rainbow colouring is still used in the sidebar list
        // (via each part's own swatch) so parts stay identifiable there,
        // but on the model itself it reads as a patchwork of disconnected
        // chunks rather than one organism - a single shared colour is what
        // actually makes the seams (already geometrically welded above)
        // look seamless too.
        const matArgs = { color: texture ? 0xffffff : (rootDef.color || sp.color), side: THREE.DoubleSide };
        if (texture) matArgs.map = texture;
        const mat = new THREE.MeshStandardMaterial(matArgs);
        mat.wireframe = !!data.savedWireframe;
        mat.emissive = new THREE.Color(0x000000);
        mat.emissiveIntensity = 0;

        let swingAxis = new THREE.Vector3(1, 0, 0);
        if (!isRoot && !isEyes) {
            swingAxis = new THREE.Vector3().crossVectors(reachDir, WORLD_UP);
            swingAxis = swingAxis.lengthSq() > 1e-6 ? swingAxis.normalize() : new THREE.Vector3(1, 0, 0);

            // Tapered bend shader: rather than rotating the entire part
            // rigidly about its pivot (which would open a crack right at the
            // seam, since seam vertices aren't exactly *at* the pivot point),
            // each vertex is rotated by an angle that scales from 0 at the
            // attachment point up to the full sway angle at the tip. The
            // rigid part of the motion - carrying this whole segment (and
            // everything attached further out on it) along with whatever
            // it's resting on - is handled separately by the kinematic chain
            // below, so the two effects combine without doubling up.
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uBendAxis = { value: swingAxis.clone() };
                shader.uniforms.uReachDir = { value: reachDir.clone() };
                shader.uniforms.uReachLen = { value: Math.max(reachLen, 1e-4) };
                shader.uniforms.uBendAngle = { value: 0 };
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    `#include <common>
                    uniform vec3 uBendAxis;
                    uniform vec3 uReachDir;
                    uniform float uReachLen;
                    uniform float uBendAngle;
                    vec3 rotateAxisAngle(vec3 v, vec3 axis, float angle) {
                        float s = sin(angle), c = cos(angle);
                        return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
                    }`
                );
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <beginnormal_vertex>',
                    `#include <beginnormal_vertex>
                    float bendT = clamp(dot(position, uReachDir) / uReachLen, 0.0, 1.0);
                    float taper = smoothstep(0.0, 1.0, bendT);
                    objectNormal = rotateAxisAngle(objectNormal, uBendAxis, uBendAngle * taper);`
                );
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
                    transformed = rotateAxisAngle(transformed, uBendAxis, uBendAngle * taper);`
                );
                mat.userData.bendShader = shader;
            };
        }

        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = sp.visible !== false;
        mesh.position.copy(pivot);
        mesh.userData.uid = uid;
        partsGroup.add(mesh);

        const wavePhase = Math.atan2(pivot.z - bodyCenter.z, pivot.x - bodyCenter.x);

        partsByUid.set(uid, {
            uid, name: sp.name || uid,
            mesh, mat, pivot, reachDir, reachLen, swingAxis, wavePhase,
            parentUid: isRoot ? null : parentUidForThis,
            isRoot, isEyes, isFin,
            baseVisible: mesh.visible,
            // Arms/tentacles: floppy, trail behind the body under drag, idle
            // sway grows with length (longer = more amplitude).
            // Fins: stiffer, undulate at their own steady rhythm rather than
            // just trailing - real squid fins ripple continuously for fine
            // steering/stabilization even when not jetting, and fold flatter
            // (less loose sway) at higher forward speed instead of just
            // dragging passively like an arm would.
            swingAmp: (isRoot || isEyes) ? 0 : (isFin ? 0.16 : 0.05 + Math.min(reachLen, 1.2) * 0.22),
            dragSensitivity: (isRoot || isEyes) ? 0 : (isFin ? 0.12 : 0.35 + Math.min(reachLen, 1.2) * 0.5)
        });
    }

    addPart(rootDef, null);
    assignOrder.forEach(uid => {
        const d = nonRootDefs.find(nd => nd.uid === uid);
        addPart(d.sp, parentOf.get(uid));
    });

    // ---- Kinematic chain ----
    // A lightweight, purely-mathematical Object3D hierarchy (never added to
    // the visible scene) that mirrors the parent/child skeleton above. Each
    // part gets an "anchor" (its own pivot, moved only by its ancestors'
    // bending - never by its own) and a nested "bend" node (this part's own
    // current sway, which is where its children attach). Because children
    // hang off their real parent's bend node rather than a fixed offset from
    // the mantle, a multi-segment arm swings as one continuous whip: each
    // link inherits exactly where the link before it ended up, so the seams
    // between segments never separate no matter how far the tip sways.
    const kinematicsRoot = new THREE.Object3D();
    const anchorOf = new Map();
    const bendOf = new Map();

    const rootAnchor = new THREE.Object3D();
    rootAnchor.position.copy(rootPivotEarly);
    kinematicsRoot.add(rootAnchor);
    const rootBend = new THREE.Object3D();
    rootAnchor.add(rootBend);
    anchorOf.set(ROOT_UID, rootAnchor);
    bendOf.set(ROOT_UID, rootBend);

    assignOrder.forEach(uid => {
        const p = partsByUid.get(uid);
        const parentBend = bendOf.get(p.parentUid);
        const anchor = new THREE.Object3D();
        anchor.position.copy(p.pivot).sub(partsByUid.get(p.parentUid).pivot);
        parentBend.add(anchor);
        const bend = new THREE.Object3D();
        anchor.add(bend);
        anchorOf.set(uid, anchor);
        bendOf.set(uid, bend);
    });

    const groupsSource = data.savedGroups || [];
    const groupedUids = new Set();
    groupsSource.forEach(g => g.memberUids.forEach(u => groupedUids.add(u)));
    const ungroupedParts = partsSource.filter(sp => !groupedUids.has(sp.uid || ''));

    // ---------------- Selection state ----------------
    const selected = new Set();

    function setHighlighted(uid, on) {
        const p = partsByUid.get(uid);
        if (!p) return;
        p.mat.emissive.set(on ? 0x3a6fd8 : 0x000000);
        p.mat.emissiveIntensity = on ? 0.75 : 0;
    }

    function refreshListHighlight() {
        listEl.querySelectorAll('.part-row').forEach(row => {
            row.classList.toggle('selected', selected.has(row.dataset.uid));
            row.classList.toggle('dimmed', isolateActive && !selected.has(row.dataset.uid));
        });
    }

    // ---------------- Isolate mode ----------------
    // Shows only the currently-selected part(s) and hides everything else,
    // so you can inspect or work on one arm/segment without the rest of the
    // squid in the way. Turning it off restores each part's own saved
    // visibility (its checkbox/eye state), not just "show everything".
    let isolateActive = false;
    const isolateBtn = document.getElementById('isolate-btn');

    function applyVisibility() {
        partsByUid.forEach(p => {
            p.mesh.visible = isolateActive ? selected.has(p.uid) : p.baseVisible;
        });
    }

    function setIsolateActive(on) {
        isolateActive = on;
        isolateBtn.classList.toggle('active', isolateActive);
        isolateBtn.textContent = isolateActive ? '👁 Show All' : '👁 Isolate';
        applyVisibility();
    }

    isolateBtn.addEventListener('click', () => {
        if (!isolateActive && selected.size === 0) return; // nothing to isolate yet
        setIsolateActive(!isolateActive);
    });

    function refreshIsolateBtnState() {
        isolateBtn.disabled = !isolateActive && selected.size === 0;
    }

    function clearSelection() {
        selected.forEach(uid => setHighlighted(uid, false));
        selected.clear();
        if (isolateActive) setIsolateActive(false); // isolating "nothing" doesn't make sense
        refreshListHighlight();
        refreshIsolateBtnState();
        refreshAnimPanel();
    }

    function selectUid(uid, additive) {
        if (!partsByUid.has(uid)) return;
        if (!additive) {
            selected.forEach(u => { if (u !== uid) setHighlighted(u, false); });
            const wasOnly = selected.has(uid) && selected.size === 1;
            selected.clear();
            if (!wasOnly) {
                selected.add(uid);
                setHighlighted(uid, true);
            } else {
                setHighlighted(uid, false);
            }
        } else if (selected.has(uid)) {
            selected.delete(uid);
            setHighlighted(uid, false);
        } else {
            selected.add(uid);
            setHighlighted(uid, true);
        }
        refreshListHighlight();
        refreshIsolateBtnState();
        refreshAnimPanel();
        if (isolateActive) applyVisibility();
    }

    function selectMany(uids) {
        selected.forEach(u => setHighlighted(u, false));
        selected.clear();
        uids.forEach(uid => {
            if (!partsByUid.has(uid)) return;
            selected.add(uid);
            setHighlighted(uid, true);
        });
        refreshListHighlight();
        refreshIsolateBtnState();
        refreshAnimPanel();
        if (isolateActive) applyVisibility();
    }

    // ---------------- Fin / Mantle animation panel ----------------
    // Selecting the fin(s) or the mantle shows a panel of the animation
    // "layers" available for that category (see FIN_ANIMATIONS /
    // MANTLE_ANIMATIONS above). Any number of a category's layers can be
    // enabled together - they're simply summed each frame in animate() -
    // so e.g. a fin can Wave Flap + Stabilize Ripple at once. "Set as
    // Default" persists the current on/off + slider state for that
    // category (via localStorage) so it's what plays automatically next
    // time, without needing the panel open.
    const animPanelEl = document.getElementById('anim-panel');
    let liveFinConfig = getDefaultConfig('fin');
    let liveMantleConfig = getDefaultConfig('mantle');

    function getLiveAnimConfig(category) { return category === 'fin' ? liveFinConfig : liveMantleConfig; }
    function getAnimDefs(category) { return category === 'fin' ? FIN_ANIMATIONS : MANTLE_ANIMATIONS; }

    function formatParamVal(v) {
        return (Math.round(v * 1000) / 1000).toString();
    }

    function renderAnimPanel(category) {
        animPanelEl.innerHTML = '';
        if (!category) { animPanelEl.style.display = 'none'; return; }
        animPanelEl.style.display = 'block';

        const defs = getAnimDefs(category);
        const cfg = getLiveAnimConfig(category);

        const title = document.createElement('div');
        title.id = 'anim-panel-title';
        title.textContent = (category === 'fin' ? 'Fin' : 'Mantle') + ' animations';
        animPanelEl.appendChild(title);

        Object.keys(defs).forEach(id => {
            const def = defs[id];
            const wrap = document.createElement('div');
            wrap.className = 'anim-def';

            const head = document.createElement('div');
            head.className = 'anim-def-head';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!cfg.enabled[id];
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => { cfg.enabled[id] = cb.checked; });
            const label = document.createElement('span');
            label.className = 'anim-def-label';
            label.textContent = def.label;
            head.appendChild(cb);
            head.appendChild(label);
            head.addEventListener('click', () => { cb.checked = !cb.checked; cfg.enabled[id] = cb.checked; });
            wrap.appendChild(head);

            const desc = document.createElement('div');
            desc.className = 'anim-def-desc';
            desc.textContent = def.desc;
            wrap.appendChild(desc);

            def.params.forEach(pdef => {
                const row = document.createElement('div');
                row.className = 'anim-param-row';
                const lbl = document.createElement('label');
                lbl.textContent = pdef.label;
                const range = document.createElement('input');
                range.type = 'range';
                range.min = pdef.min; range.max = pdef.max; range.step = pdef.step;
                range.value = cfg.params[id][pdef.key];
                const val = document.createElement('span');
                val.className = 'val';
                val.textContent = formatParamVal(cfg.params[id][pdef.key]);
                range.addEventListener('input', () => {
                    cfg.params[id][pdef.key] = parseFloat(range.value);
                    val.textContent = formatParamVal(cfg.params[id][pdef.key]);
                });
                row.appendChild(lbl); row.appendChild(range); row.appendChild(val);
                wrap.appendChild(row);
            });

            animPanelEl.appendChild(wrap);
        });

        const defaultBtn = document.createElement('button');
        defaultBtn.id = 'anim-default-btn';
        defaultBtn.textContent = '★ Set as Default';
        const status = document.createElement('div');
        status.id = 'anim-default-status';
        defaultBtn.addEventListener('click', () => {
            saveStoredDefault(category, cfg);
            status.textContent = 'Saved as default for this session\'s and future loads ✓';
            setTimeout(() => { if (status.textContent) status.textContent = ''; }, 2500);
        });
        animPanelEl.appendChild(defaultBtn);
        animPanelEl.appendChild(status);
    }

    function selectionAnimCategory() {
        if (selected.size === 0) return null;
        let allFin = true, allMantle = true;
        selected.forEach(uid => {
            const p = partsByUid.get(uid);
            if (!p || !p.isFin) allFin = false;
            if (!p || !p.isRoot) allMantle = false;
        });
        if (allFin) return 'fin';
        if (allMantle) return 'mantle';
        return null; // mixed selection (e.g. a fin + an arm) - no single category applies
    }

    function refreshAnimPanel() { renderAnimPanel(selectionAnimCategory()); }

    refreshIsolateBtnState(); // nothing selected yet, so start disabled
    refreshAnimPanel();       // nothing selected yet, so panel starts hidden

    // ---------------- Sidebar part list ----------------
    const listEl = document.getElementById('part-list');

    function makeRow(uid) {
        const p = partsByUid.get(uid);
        const sp = partsSource.find(s => (s.uid || '') === uid);
        const row = document.createElement('div');
        row.className = 'part-row';
        row.dataset.uid = uid;
        row.innerHTML = '<span class="swatch" style="background:' + (sp ? sp.color : '#ccc') + '"></span>' +
                         '<span class="pname"></span>';
        row.querySelector('.pname').textContent = p.name;
        row.addEventListener('click', (e) => selectUid(uid, e.ctrlKey || e.metaKey));
        return row;
    }

    groupsSource.forEach(g => {
        const groupEl = document.createElement('div');
        groupEl.className = 'part-group';
        const header = document.createElement('div');
        header.className = 'group-header';
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = g.collapsed ? '▶' : '▼';
        const gname = document.createElement('span');
        gname.className = 'gname';
        gname.textContent = g.name;
        header.appendChild(caret);
        header.appendChild(gname);

        const membersEl = document.createElement('div');
        membersEl.className = 'group-members';
        membersEl.style.display = g.collapsed ? 'none' : 'block';

        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            const hidden = membersEl.style.display === 'none';
            membersEl.style.display = hidden ? 'block' : 'none';
            caret.textContent = hidden ? '▼' : '▶';
        });
        header.addEventListener('click', () => selectMany(g.memberUids));

        g.memberUids.forEach(uid => {
            if (partsByUid.has(uid)) membersEl.appendChild(makeRow(uid));
        });
        groupEl.appendChild(header);
        groupEl.appendChild(membersEl);
        listEl.appendChild(groupEl);
    });

    ungroupedParts.forEach(sp => {
        const uid = sp.uid || '';
        if (partsByUid.has(uid)) listEl.appendChild(makeRow(uid));
    });

    // ---------------- Click-to-select on the 3D model ----------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = null;

    renderer.domElement.addEventListener('pointerdown', (e) => {
        downPos = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener('pointerup', (e) => {
        if (!downPos) return;
        const dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
        downPos = null;
        if (Math.hypot(dx, dy) > 4) return; // treat as an orbit drag, not a click

        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(partsGroup.children, false);
        const additive = e.ctrlKey || e.metaKey;
        if (hits.length) {
            selectUid(hits[0].object.userData.uid, additive);
        } else if (!additive) {
            clearSelection();
        }
    });

    // ---------------- Pause / Swim controls ----------------
    let paused = false;
    const pauseBtn = document.getElementById('pause-btn');
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.textContent = paused ? '▶ Play' : '⏸ Pause';
        pauseBtn.classList.toggle('paused', paused);
    });

    let swimMode = false;
    const swimBtn = document.getElementById('swim-btn');
    swimBtn.addEventListener('click', () => {
        swimMode = !swimMode;
        swimBtn.textContent = swimMode ? '■ Hover' : '▲ Swim Up';
        swimBtn.classList.toggle('active', swimMode);
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // ---------------- Swim animation ----------------
    // Real squid move by jetting: the mantle contracts rhythmically, pushing
    // water out and thrusting the body forward/up, while the arms, tentacles
    // and fins - hinged at the mantle, and at each other - trail and sway
    // passively, deflecting opposite the direction of motion (drag) rather
    // than moving on their own.
    const clock = new THREE.Clock();
    let simTime = 0;
    
    let swimVelocity = 0;        // vertical velocity from jetting
    let climbY = 0;              // integrated vertical position

    const _worldPos = new THREE.Vector3();
    const _worldQuat = new THREE.Quaternion();

    function animate() {
        const dt = Math.min(clock.getDelta(), 0.05);
        if (!paused) {
            simTime += dt;

            // Mantle: sum whatever mantle animation layers are currently
            // enabled (Jet Pulse / Idle Sway / Body Ripple - see
            // MANTLE_ANIMATIONS above and the Mantle panel in the sidebar).
            // Multiple layers run simultaneously, e.g. the jet pulse and a
            // ripple both contributing to the body's scale each frame.
            const mantleCtx = { simTime, swimVelocity };
            let mScaleAxis = 0, mScaleOther = 0, mRotZ = 0, mRotX = 0, mSqueeze = 0;
            Object.keys(MANTLE_ANIMATIONS).forEach(id => {
                if (!liveMantleConfig.enabled[id]) return;
                const res = MANTLE_ANIMATIONS[id].compute(mantleCtx, liveMantleConfig.params[id]);
                if (res.scaleAxis) mScaleAxis += res.scaleAxis;
                if (res.scaleOther) mScaleOther += res.scaleOther;
                if (res.rotZ) mRotZ += res.rotZ;
                if (res.rotX) mRotX += res.rotX;
                if (typeof res.squeeze === 'number') mSqueeze = res.squeeze; // only Jet Pulse defines this
            });

            // Squeeze along the body's long axis, bulge slightly on the
            // other two - a simple volume-conserving jet-propulsion pump.
            const root = partsByUid.get(ROOT_UID);
            if (root) {
                root.mesh.scale.set(1, 1, 1);
                root.mesh.scale.setComponent(axisIdx, 1 + mScaleAxis);
                root.mesh.scale.setComponent((axisIdx + 1) % 3, 1 + mScaleOther);
                root.mesh.scale.setComponent((axisIdx + 2) % 3, 1 + mScaleOther);
                // Everything hinged off the mantle rides along with its
                // breathing pulse - matched here on the root's own bend node
                // so it propagates down every appendage's kinematic chain.
                rootBend.scale.copy(root.mesh.scale);
            }

            // Whole-body vertical physics: each Jet Pulse contraction adds a
            // little upward thrust when "Swim Up" is active; drag always
            // bleeds velocity off. When not swimming, it eases back to a
            // resting hover. (If Jet Pulse is switched off, mSqueeze stays 0
            // and the squid simply won't generate thrust from swimming.)
            if (swimMode) swimVelocity += mSqueeze * 1.5 * dt;
            swimVelocity -= swimVelocity * Math.min(1, 1.8 * dt);
            climbY += swimVelocity * dt;
            if (swimMode) {
                if (climbY > 1.0) climbY -= (climbY - 1.0) * 3 * dt; // soft ceiling
            } else {
                climbY += (0 - climbY) * Math.min(1, 1.2 * dt); // settle back down
            }

            squidRoot.position.y = climbY + Math.sin(simTime * 0.5) * 0.015;
            squidRoot.rotation.z = mRotZ - swimVelocity * 0.15;
            squidRoot.rotation.x = mRotX + swimVelocity * 0.2;

            // Appendages: idle undulation plus a drag deflection that responds
            // to how fast the body is currently climbing (trailing behind).
            // Each part's own sway is stored on its "bend" node in the
            // kinematic chain - so a child part attached further out on the
            // same arm inherits its parent's current sway automatically,
            // instead of only tracking the mantle. The same angle also drives
            // the tapered bend shader on that part's own geometry, so the
            // segment curves smoothly from its (now correctly-tracked) seam
            // out to its tip.
            const finCtx = { simTime, swimVelocity };
            partsByUid.forEach(p => {
                if (p.isRoot) return;
                // Baseline drag-deflection physics (arms trail behind the
                // body as it moves, fins fold back a little) - always on,
                // independent of which style layers are enabled.
                const dragSway = -swimVelocity * p.dragSensitivity;
                let styleSway = 0;

                if (p.isFin) {
                    // Sum whichever fin animation layers are currently
                    // enabled (Wave Flap / Stabilize Ripple / Speed Fold -
                    // see FIN_ANIMATIONS above and the Fin panel in the
                    // sidebar). Multiple layers run simultaneously.
                    Object.keys(FIN_ANIMATIONS).forEach(id => {
                        if (!liveFinConfig.enabled[id]) return;
                        styleSway += FIN_ANIMATIONS[id].compute(p, finCtx, liveFinConfig.params[id]);
                    });
                } else {
                    // Natural arm/tentacle motion with trailing and curling -
                    
                    styleSway = computeArmAnimation(p, simTime, swimVelocity)
                              
                }

                const totalBend = styleSway + dragSway;
                bendOf.get(p.uid).quaternion.setFromAxisAngle(p.swingAxis, totalBend);
                const shader = p.mat.userData.bendShader;
                if (shader) shader.uniforms.uBendAngle.value = totalBend;
            });

            kinematicsRoot.updateMatrixWorld(true);

            partsByUid.forEach(p => {
                if (p.isRoot) return;
                const anchor = anchorOf.get(p.uid);
                anchor.getWorldPosition(_worldPos);
                p.mesh.position.copy(_worldPos);
                if (p.isEyes) {
                    p.mesh.quaternion.identity();
                } else {
                    anchor.getWorldQuaternion(_worldQuat);
                    p.mesh.quaternion.copy(_worldQuat);
                }
            });
        }
        controls.update();
        renderer.render(scene, camera);
    }
    renderer.setAnimationLoop(animate);
