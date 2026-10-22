/**
 * Procedural Canvas 2D texture factory for Three.js materials.
 */

export const TextureFactory = {
    createPromenadeTileTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        // Classic Sportivnaya Embankment terracotta & grey interlocking tiles
        ctx.fillStyle = '#334155';
        ctx.fillRect(0, 0, 512, 512);

        const rows = 8;
        const cols = 8;
        const w = 512 / cols;
        const h = 512 / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const isRedStripe = (c === 0 || c === 7 || (r + c) % 4 === 0);
                ctx.fillStyle = isRedStripe ? '#7c2d12' : ((r + c) % 2 === 0 ? '#475569' : '#64748b');
                ctx.fillRect(c * w + 3, r * h + 3, w - 6, h - 6);
                ctx.strokeStyle = '#1e293b';
                ctx.lineWidth = 2;
                ctx.strokeRect(c * w + 3, r * h + 3, w - 6, h - 6);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(6, 48);
        return tex;
    },

    createSignTexture(title, subtitle, bgHex = '#0f172a', accentHex = '#f59e0b', textHex = '#ffffff') {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 192;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = bgHex;
        ctx.fillRect(0, 0, 512, 192);

        ctx.strokeStyle = accentHex;
        ctx.lineWidth = 10;
        ctx.strokeRect(8, 8, 496, 176);

        ctx.fillStyle = accentHex;
        ctx.font = '900 48px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, 256, 76);

        ctx.fillStyle = textHex;
        ctx.font = '700 26px "Inter", sans-serif';
        ctx.fillText(subtitle, 256, 136);

        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    },

    createBuildingFacadeTexture(baseHex, windowHex, cols = 6, rows = 8) {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = baseHex;
        ctx.fillRect(0, 0, 512, 512);

        const padX = 18;
        const padY = 16;
        const cellW = 512 / cols;
        const cellH = 512 / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const lit = ((r * 7 + c * 3) % 5 !== 0);
                ctx.fillStyle = lit ? windowHex : '#1e293b';
                ctx.fillRect(c * cellW + padX, r * cellH + padY, cellW - padX * 2, cellH - padY * 2);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createCustomShirtTexture(username = 'Игрок', accentHex = '#38bdf8') {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, 256, 256);

        ctx.fillStyle = accentHex;
        ctx.fillRect(0, 36, 256, 12);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(0, 52, 256, 6);

        const displayUser = '@' + String(username || 'Игрок');
        ctx.fillStyle = accentHex;
        const fontSize = displayUser.length > 16 ? 18 : (displayUser.length > 12 ? 22 : 28);
        ctx.font = `900 ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(displayUser, 128, 125);

        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 20px sans-serif';
        ctx.fillText('VVO • 25 RUS', 128, 162);

        return new THREE.CanvasTexture(canvas);
    },

    createPlayerShirtTexture(username = 'Игрок', accentHex = '#38bdf8') {
        return this.createCustomShirtTexture(username, accentHex);
    },

    createCpro29aShirtTexture(username = 'Игрок') {
        return this.createCustomShirtTexture(username, '#38bdf8');
    },

    createProceduralSkyMaterial() {
        if (typeof THREE === 'undefined') return null;

        const vertexShader = `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPos.xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

        const fragmentShader = `
            uniform vec3 topColor;
            uniform vec3 horizonColor;
            uniform vec3 groundColor;
            uniform vec3 sunPosition;
            uniform vec3 sunColor;
            uniform vec3 sunsetGlowColor;
            uniform float sunGlowIntensity;
            uniform float sunDiskSize;
            uniform float isDawn;
            uniform vec3 dawnEastColor;
            uniform vec3 dawnWestColor;
            uniform float starIntensity;

            varying vec3 vWorldPosition;

            void main() {
                vec3 rayDir = normalize(vWorldPosition);
                vec3 sunDir = normalize(sunPosition);

                float h = rayDir.y;

                // Vertical gradient
                vec3 skyGrad;
                if (h >= 0.0) {
                    float t = pow(clamp(h, 0.0, 1.0), 0.65);
                    skyGrad = mix(horizonColor, topColor, t);
                } else {
                    float t = pow(clamp(-h * 4.0, 0.0, 1.0), 0.8);
                    skyGrad = mix(horizonColor, groundColor, t);
                }

                // Dawn mode: East (+X) crimson/amber, West (-X) morning blue
                if (isDawn > 0.5) {
                    float eastFactor = clamp(rayDir.x * 0.5 + 0.5, 0.0, 1.0);
                    vec3 dawnColor = mix(dawnWestColor, dawnEastColor, eastFactor);
                    float horizonBand = exp(-max(0.0, h) * 3.5);
                    skyGrad = mix(skyGrad, dawnColor, horizonBand * 0.88);
                }

                // Sun alignment and reflections
                float cosAngle = dot(rayDir, sunDir);

                // Horizon sunset / dawn warmth around the sun azimuth
                float sunHorizonHaze = exp(-abs(h) * 4.5) * pow(max(0.0, cosAngle * 0.5 + 0.5), 3.0);
                vec3 horizonGlow = sunsetGlowColor * (sunHorizonHaze * sunGlowIntensity * 1.5);

                // Wide corona around the sun
                float corona = pow(max(0.0, cosAngle), 32.0) * 0.75 + pow(max(0.0, cosAngle), 128.0) * 1.4;
                vec3 sunCorona = sunColor * (corona * sunGlowIntensity);

                // Sharp sun disk exactly at sunDir
                float disk = smoothstep(sunDiskSize - 0.0006, sunDiskSize, cosAngle);
                vec3 diskColor = (sunColor + vec3(0.4)) * disk * 2.5;

                vec3 finalColor = skyGrad + horizonGlow + sunCorona + diskColor;

                // Night / dusk stars
                if (starIntensity > 0.01 && h > 0.08) {
                    vec3 p = floor(rayDir * 180.0);
                    float n = fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
                    if (n > 0.985) {
                        float starBrightness = (n - 0.985) / 0.015 * starIntensity * smoothstep(0.08, 0.3, h);
                        finalColor += vec3(starBrightness);
                    }
                }

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        const uniforms = {
            topColor: { value: new THREE.Color(0x0284c7) },
            horizonColor: { value: new THREE.Color(0xbae6fd) },
            groundColor: { value: new THREE.Color(0x1e293b) },
            sunPosition: { value: new THREE.Vector3(-70, 180, -35) },
            sunColor: { value: new THREE.Color(0xffffff) },
            sunsetGlowColor: { value: new THREE.Color(0xfb923c) },
            sunGlowIntensity: { value: 1.0 },
            sunDiskSize: { value: 0.9993 },
            isDawn: { value: 0.0 },
            dawnEastColor: { value: new THREE.Color(0xff3300) },
            dawnWestColor: { value: new THREE.Color(0x1d4ed8) },
            starIntensity: { value: 0.0 }
        };

        return new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            uniforms,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false
        });
    },

    createSkyDomeTexture(presetOrPhase) {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        let phase = 'day';
        if (typeof presetOrPhase === 'string') {
            phase = presetOrPhase;
        } else if (presetOrPhase === 0) {
            phase = 'sunset';
        } else if (presetOrPhase === 1) {
            phase = 'fog';
        } else if (presetOrPhase === 2) {
            phase = 'night';
        } else if (presetOrPhase === 4) {
            phase = 'dawn';
        } else {
            phase = 'day';
        }

        if (phase === 'dawn') {
            // Dawn: Red/crimson sky on East (+X, center 512), deep blue on West (-X, edges 0 & 1024)
            const baseGrad = ctx.createLinearGradient(0, 0, 0, 512);
            baseGrad.addColorStop(0.0, '#0a0f1d');
            baseGrad.addColorStop(0.35, '#1e293b');
            baseGrad.addColorStop(0.65, '#1e3a8a');
            baseGrad.addColorStop(1.0, '#172554');
            ctx.fillStyle = baseGrad;
            ctx.fillRect(0, 0, 1024, 512);

            const westBlue = ctx.createLinearGradient(0, 0, 1024, 0);
            westBlue.addColorStop(0.0, 'rgba(30, 64, 175, 0.85)');
            westBlue.addColorStop(0.2, 'rgba(37, 99, 235, 0.45)');
            westBlue.addColorStop(0.35, 'rgba(37, 99, 235, 0.0)');
            westBlue.addColorStop(0.65, 'rgba(37, 99, 235, 0.0)');
            westBlue.addColorStop(0.8, 'rgba(37, 99, 235, 0.45)');
            westBlue.addColorStop(1.0, 'rgba(30, 64, 175, 0.85)');
            ctx.fillStyle = westBlue;
            ctx.fillRect(0, 0, 1024, 512);

            const eastRadial = ctx.createRadialGradient(512, 360, 20, 512, 360, 360);
            eastRadial.addColorStop(0.0, 'rgba(254, 240, 138, 0.95)');
            eastRadial.addColorStop(0.25, 'rgba(249, 115, 22, 0.92)');
            eastRadial.addColorStop(0.55, 'rgba(225, 29, 72, 0.88)');
            eastRadial.addColorStop(0.80, 'rgba(159, 18, 57, 0.65)');
            eastRadial.addColorStop(1.0, 'rgba(30, 58, 138, 0.0)');
            ctx.fillStyle = eastRadial;
            ctx.fillRect(0, 0, 1024, 512);

            const eastHorizon = ctx.createLinearGradient(200, 0, 824, 0);
            eastHorizon.addColorStop(0.0, 'rgba(225, 29, 72, 0.0)');
            eastHorizon.addColorStop(0.25, 'rgba(225, 29, 72, 0.75)');
            eastHorizon.addColorStop(0.5, 'rgba(251, 146, 60, 0.9)');
            eastHorizon.addColorStop(0.75, 'rgba(225, 29, 72, 0.75)');
            eastHorizon.addColorStop(1.0, 'rgba(225, 29, 72, 0.0)');
            ctx.fillStyle = eastHorizon;
            ctx.fillRect(200, 270, 624, 130);

            // Morning stars in the west
            for (let i = 0; i < 40; i++) {
                const sx = i % 2 === 0 ? (i * 5) % 220 : 1024 - ((i * 5) % 220);
                const sy = 30 + (i * 19) % 150;
                ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
                ctx.beginPath();
                ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (phase === 'sunset') {
            // Sunset over Amur Bay (West: -X at u=0 and u=1)
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0.0, '#090d1e');
            grad.addColorStop(0.28, '#1e1b4b');
            grad.addColorStop(0.46, '#7c2d12');
            grad.addColorStop(0.54, '#f97316');
            grad.addColorStop(0.62, '#fde047');
            grad.addColorStop(1.0, '#1e293b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 1024, 512);

            for (let i = 0; i < 90; i++) {
                const sx = (Math.sin(i * 78.233) * 0.5 + 0.5) * 1024;
                const sy = (Math.cos(i * 45.164) * 0.5 + 0.5) * 140;
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.beginPath();
                ctx.arc(sx, sy, 1.0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (phase === 'fog') {
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0.0, '#475569');
            grad.addColorStop(0.45, '#94a3b8');
            grad.addColorStop(0.58, '#cbd5e1');
            grad.addColorStop(1.0, '#64748b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 1024, 512);
        } else if (phase === 'dusk') {
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0.0, '#050713');
            grad.addColorStop(0.35, '#0c0a2a');
            grad.addColorStop(0.55, '#312e81');
            grad.addColorStop(0.70, '#4338ca');
            grad.addColorStop(1.0, '#1e1b4b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 1024, 512);

            for (let i = 0; i < 180; i++) {
                const sx = (Math.sin(i * 78.233) * 0.5 + 0.5) * 1024;
                const sy = (Math.cos(i * 45.164) * 0.5 + 0.5) * 200;
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.beginPath();
                ctx.arc(sx, sy, (i % 3 === 0) ? 1.5 : 1.0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (phase === 'night') {
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0.0, '#02040a');
            grad.addColorStop(0.42, '#090f24');
            grad.addColorStop(0.54, '#1e293b');
            grad.addColorStop(1.0, '#020617');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 1024, 512);

            for (let i = 0; i < 340; i++) {
                const sx = (Math.sin(i * 78.233) * 0.5 + 0.5) * 1024;
                const sy = (Math.cos(i * 45.164) * 0.5 + 0.5) * 250;
                ctx.fillStyle = 'rgba(255,255,255,0.88)';
                ctx.beginPath();
                ctx.arc(sx, sy, (i % 4 === 0) ? 1.7 : 1.0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            // Day
            const grad = ctx.createLinearGradient(0, 0, 0, 512);
            grad.addColorStop(0.0, '#0369a1');
            grad.addColorStop(0.38, '#0ea5e9');
            grad.addColorStop(0.54, '#bae6fd');
            grad.addColorStop(1.0, '#0284c7');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 1024, 512);
        }

        const cloudCount = phase === 'fog' ? 85 : 45;
        for (let i = 0; i < cloudCount; i++) {
            const cx = ((i * 137.5) % 1024);
            const cy = 95 + ((i * 43.7) % 155);
            const cw = 70 + (i % 5) * 32;
            const ch = 14 + (i % 4) * 8;

            if (phase === 'dawn') {
                ctx.fillStyle = i % 2 === 0 ? 'rgba(251, 146, 60, 0.28)' : 'rgba(244, 63, 94, 0.22)';
            } else if (phase === 'sunset') {
                ctx.fillStyle = i % 2 === 0 ? 'rgba(251, 146, 60, 0.28)' : 'rgba(244, 63, 94, 0.22)';
            } else if (phase === 'fog') {
                ctx.fillStyle = 'rgba(226, 232, 240, 0.35)';
            } else if (phase === 'night' || phase === 'dusk') {
                ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
            }

            ctx.beginPath();
            ctx.ellipse(cx, cy, cw, ch, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        return tex;
    },

    createPoliceRibbonTexture() {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Base background: bright hazard yellow (#facc15)
        ctx.fillStyle = '#facc15';
        ctx.fillRect(0, 0, 512, 64);

        // 45-degree diagonal alternating black hazard chevrons on top (14px) and bottom (14px) margins
        const stripeW = 16;
        ctx.fillStyle = '#09090b';

        // Top margin chevrons (0 to 14px)
        for (let x = -32; x < 512 + 32; x += stripeW * 2) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x + stripeW, 0);
            ctx.lineTo(x + stripeW - 14, 14);
            ctx.lineTo(x - 14, 14);
            ctx.closePath();
            ctx.fill();
        }

        // Bottom margin chevrons (50px to 64px)
        for (let x = -32; x < 512 + 32; x += stripeW * 2) {
            ctx.beginPath();
            ctx.moveTo(x, 50);
            ctx.lineTo(x + stripeW, 50);
            ctx.lineTo(x + stripeW - 14, 64);
            ctx.lineTo(x - 14, 64);
            ctx.closePath();
            ctx.fill();
        }

        // Sharp dividing horizontal border lines
        ctx.strokeStyle = '#09090b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 14);
        ctx.lineTo(512, 14);
        ctx.moveTo(0, 50);
        ctx.lineTo(512, 50);
        ctx.stroke();

        // Bold black cautionary text in center
        ctx.fillStyle = '#09090b';
        ctx.font = '900 17px "Arial Black", "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POLICE LINE DO NOT CROSS • ОПАСНАЯ ЗОНА', 256, 32);

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        return tex;
    },

    createHazardPoleTexture() {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Alternating horizontal black and hazard yellow bands
        const bands = 8;
        const bandH = 128 / bands;
        for (let i = 0; i < bands; i++) {
            ctx.fillStyle = (i % 2 === 0) ? '#facc15' : '#18181b';
            ctx.fillRect(0, i * bandH, 64, bandH);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1, 4);
        return tex;
    },

    createAsphaltRoadTexture(orientation = 'z') {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Base dark asphalt color
        ctx.fillStyle = '#1e242b';
        ctx.fillRect(0, 0, 512, 512);

        // Aggregate noise speckles
        for (let i = 0; i < 1800; i++) {
            const x = (i * 137.5) % 512;
            const y = (i * 293.7) % 512;
            ctx.fillStyle = (i % 2 === 0) ? '#282f38' : '#161a20';
            ctx.fillRect(x, y, 2, 2);
        }

        // Road markings
        const isX = orientation === 'x';
        ctx.fillStyle = '#f1f5f9';

        if (isX) {
            // Road along X: width along Y/Z
            // Solid outer white edge lines
            ctx.fillRect(0, 18, 512, 5);
            ctx.fillRect(0, 512 - 23, 512, 5);

            // Center dashed line
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = 5;
            ctx.setLineDash([44, 28]);
            ctx.beginPath();
            ctx.moveTo(0, 256);
            ctx.lineTo(512, 256);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            // Road along Z: width along X
            // Solid outer white edge lines
            ctx.fillRect(18, 0, 5, 512);
            ctx.fillRect(512 - 23, 0, 5, 512);

            // Center dashed line
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = 5;
            ctx.setLineDash([44, 28]);
            ctx.beginPath();
            ctx.moveTo(256, 0);
            ctx.lineTo(256, 512);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createSidewalkTileTexture() {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Dark grout mortar background
        ctx.fillStyle = '#475569';
        ctx.fillRect(0, 0, 256, 256);

        const gridSize = 4;
        const cellSize = 256 / gridSize;
        const pad = 3;

        for (let r = 0; r < gridSize; r++) {
            for (let c = 0; c < gridSize; c++) {
                const x = c * cellSize + pad;
                const y = r * cellSize + pad;
                const w = cellSize - pad * 2;
                const h = cellSize - pad * 2;

                const tone = ((r * 3 + c * 7) % 5);
                ctx.fillStyle = tone === 0 ? '#8fa0b5' : (tone === 1 ? '#9db0c6' : (tone === 2 ? '#94a3b8' : '#8a9bb0'));
                ctx.fillRect(x, y, w, h);

                // Bevel highlights
                ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
                ctx.fillRect(x, y, w, 2);
                ctx.fillRect(x, y, 2, h);

                ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
                ctx.fillRect(x, y + h - 2, w, 2);
                ctx.fillRect(x + w - 2, y, 2, h);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createGrassTexture() {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Base lush park lawn green
        ctx.fillStyle = '#285e2b';
        ctx.fillRect(0, 0, 256, 256);

        // Lawn mower subtle alternating bands
        const bands = 8;
        const bandH = 256 / bands;
        for (let i = 0; i < bands; i++) {
            ctx.fillStyle = (i % 2 === 0) ? 'rgba(56, 130, 61, 0.25)' : 'rgba(31, 72, 33, 0.25)';
            ctx.fillRect(0, i * bandH, 256, bandH);
        }

        // Natural grass blade organic speckles
        for (let i = 0; i < 2200; i++) {
            const x = (i * 97.3) % 256;
            const y = (i * 181.7) % 256;
            const tone = i % 4;
            ctx.fillStyle = tone === 0 ? '#38823d' : (tone === 1 ? '#449e4a' : (tone === 2 ? '#1f4821' : '#307134'));
            ctx.fillRect(x, y, 2, 3);
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createPlazaPavingTexture() {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Granite mortar joint color
        ctx.fillStyle = '#44403c';
        ctx.fillRect(0, 0, 256, 256);

        // Decorative stone paving pattern
        const gridSize = 4;
        const cellSize = 256 / gridSize;
        const pad = 2;

        for (let r = 0; r < gridSize; r++) {
            for (let c = 0; c < gridSize; c++) {
                const x = c * cellSize + pad;
                const y = r * cellSize + pad;
                const w = cellSize - pad * 2;
                const h = cellSize - pad * 2;

                const tone = ((r * 5 + c * 9) % 4);
                ctx.fillStyle = tone === 0 ? '#a8a29e' : (tone === 1 ? '#78716c' : (tone === 2 ? '#b8b2ad' : '#8c8580'));
                ctx.fillRect(x, y, w, h);

                // Subtle inner border
                ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
                ctx.fillRect(x, y, w, 2);
                ctx.fillRect(x, y, 2, h);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
                ctx.fillRect(x, y + h - 2, w, 2);
                ctx.fillRect(x + w - 2, y, 2, h);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    },

    createLightPoolTexture(innerRgba = 'rgba(255, 250, 224, 0.55)', outerRgba = 'rgba(254, 240, 138, 0)') {
        if (typeof document === 'undefined' || typeof THREE === 'undefined') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, innerRgba);
        grad.addColorStop(0.35, 'rgba(254, 243, 199, 0.35)');
        grad.addColorStop(0.7, 'rgba(253, 224, 71, 0.12)');
        grad.addColorStop(1, outerRgba);

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);

        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    }
};
