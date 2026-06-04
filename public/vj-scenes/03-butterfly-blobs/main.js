import Analyzer from '/sounds/Analyzer.js'
import * as THREE from 'three'

const PALETTE = [
	'#E9D3FB', '#BEB8EA', '#BAC2D7', '#B09C69',
	'#AA3F3D', '#683D73', '#75A8BD', '#60A779',
	'#D738A9', '#C47448', '#A1A590', '#92428B',
	'#CEB1B1', '#404027', '#7F7467', '#3F211C',
	'#F3B3EB',
]

const MODES = [ 'mono', /*'couleur',*/ 'réseau', 'chaos' ]
const BACKGROUND_COLORS = [ '#06060a', '#06060a', '#061a0a', '#160824' ]   // noir, noir, vert, violet

// Scripted track — stages advance when kick count reaches kicksToNext
const TRACK = [
	{ mode: 'mono',  bgType: 'white',   blendMode: 'normal',   kicksToNext: 10 },   // 0 – intro blanc
	{ mode: 'mono',  bgType: 'sky',     blendMode: 'multiply', kicksToNext: 10 },   // 1 – ciel
	{ mode: 'chaos', bgType: 'color',   blendMode: 'normal',   kicksToNext: 12 },   // 2 – chaos
	{ mode: 'mono',  bgType: 'tornado', blendMode: 'multiply', kicksToNext: 10 },   // 3 – tornade
	{ mode: 'chaos', bgType: 'color',   blendMode: 'normal',   heavy: true  },      // 4 – chaos final
]

class ButterflyBlobsScene {

	constructor( audio ) {
		this.audio = audio
		this._raf  = null
		this.t     = 0

		// canvas / DOM
		this.canvas = null
		this.ctx    = null
		this.wrap   = null
		this._three = null   // Three.js background renderer

		// track / stage state
		this._trackStage    = 0
		this._kickCount     = 0
		this._lastKickTime  = -999   // cooldown between counted kicks


		// visual params (editable - no GUI in VJ mode)
		this.params = {
			blobs:     350,
			taille:    0.8,
			vitesse:   0.6,
			pulseAmp:  0.12,
			flou:      8,
			contraste: 14,
			seuil:     0.25,
			mode:      'mono',     // initial stage: mono blanc
			variation: 0.5,
		}

		// sampling state
		this.blobs       = []
		this.samplePts   = []
		this.cumWeights  = []
		this.totalWeight = 0
		this.imgW        = 400
		this.imgH        = 360
		this.imgData     = null

		// Lorenz attractor state — persists across mode switches
		this._lorenz = {
			x: 0.1, y: 0, z: 0,
			trail:    [],
			maxTrail: 4000,
		}

		// Image wall state — persists across mode switches
		this._chaosWall = {
			pool:    [],
			poolIdx: 0,
			active:  [],
			lastPop: -999,
		}

		// Background state
		this._bg = {
			colorIdx: 1,   // index dans BACKGROUND_COLORS (le canvas crème couvre le bg en stage blanc)
		}
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	async load() {
		this._fetchArtworkPool()    // fire-and-forget; fills butterfly image pool
		return new Promise( ( resolve ) => {
			const img = new Image()
			img.crossOrigin = 'anonymous'
			img.src = '/butterfly.png'
			img.onload = () => {
				this.imgW = img.naturalWidth  || img.width  || 400
				this.imgH = img.naturalHeight || img.height || 360
				const off    = document.createElement( 'canvas' )
				off.width    = this.imgW
				off.height   = this.imgH
				const offCtx = off.getContext( '2d' )
				offCtx.drawImage( img, 0, 0 )
				this.imgData = offCtx.getImageData( 0, 0, this.imgW, this.imgH ).data
				resolve()
			}
			img.onerror = resolve   // graceful fallback - blobs will be skipped
		} )
	}

	async _fetchArtworkPool() {
		try {
			const r        = await fetch( 'https://api.artic.edu/api/v1/artworks/search?q=butterfly&fields=id,image_id&limit=100', { signal: AbortSignal.timeout( 8000 ) } )
			const { data } = await r.json()
			this._chaosWall.pool = data
				.filter( d => d.image_id )
				.map( d => `https://www.artic.edu/iiif/2/${d.image_id}/full/400,/0/default.jpg` )
				.sort( () => Math.random() - 0.5 )
		} catch { /* offline or timeout */ }
	}

	_loadImageFromPool( urls ) {
		if ( ! urls.length ) { this._switchToColor(); return }
		const url = urls[ Math.floor( Math.random() * urls.length ) ]
		new THREE.TextureLoader().load(
			url,
			( tex ) => {
				tex.colorSpace = THREE.SRGBColorSpace
				// cover UV — calculé une fois à la fin du chargement
				const img       = tex.image
				const vpAspect  = innerWidth / innerHeight
				const imgAspect = img.naturalWidth / img.naturalHeight
				if ( vpAspect > imgAspect ) {
					tex.repeat.set( 1, imgAspect / vpAspect )
					tex.offset.set( 0, ( 1 - imgAspect / vpAspect ) / 2 )
				} else {
					tex.repeat.set( vpAspect / imgAspect, 1 )
					tex.offset.set( ( 1 - vpAspect / imgAspect ) / 2, 0 )
				}
				if ( this._three.imageTexture ) this._three.imageTexture.dispose()
				this._three.imageTexture      = tex
				this._three.material.map      = tex
				this._three.material.color.set( 0xffffff )
				this._three.material.needsUpdate = true
			},
			undefined,
			() => this._switchToColor(),
		)
	}

	_playVideo( url ) {
		const { video, material } = this._three
		video.src = url
		video.play().catch( () => this._switchToColor() )
		if ( this._three.videoTexture ) this._three.videoTexture.dispose()
		const tex = new THREE.VideoTexture( video )
		tex.colorSpace = THREE.SRGBColorSpace
		this._three.videoTexture = tex
		material.map = tex
		material.color.set( 0xffffff )
		material.needsUpdate = true
	}

	_switchToColor() {
		const { video, material } = this._three
		video.pause()
		video.src = ''
		if ( this._three.videoTexture ) {
			this._three.videoTexture.dispose()
			this._three.videoTexture = null
		}
		if ( this._three.imageTexture ) {
			this._three.imageTexture.dispose()
			this._three.imageTexture = null
		}
		material.map = null
		material.color.setStyle( BACKGROUND_COLORS[ this._bg.colorIdx ] )
		material.needsUpdate = true
	}

	_applyBgColor() {
		if ( ! this._three ) return
		this._switchToColor()
	}

	_advanceStage() {
		const next = this._trackStage + 1
		if ( next >= TRACK.length ) return
		this._trackStage = next
		this._kickCount  = 0
		const stage      = TRACK[ this._trackStage ]
		this.params.mode = stage.mode

		if ( stage.mode === 'mono'  ) { this.params.contraste = 14; this.params.flou = 8 }
		if ( stage.mode === 'chaos' ) { this.params.contraste = 1;  this.params.flou = 0 }

		// fallback color index before potentially playing video (in case video fails)
		if      ( stage.bgType === 'white'   ) this._bg.colorIdx = 1
		else if ( stage.bgType === 'sky'     ) this._bg.colorIdx = 1
		else if ( stage.bgType === 'tornado' ) this._bg.colorIdx = 0
		else if ( stage.bgType === 'color'   ) this._bg.colorIdx = stage.heavy ? 3 : 0

		if      ( stage.bgType === 'sky'     ) this._loadImageFromPool( [ '/girlButterfly.png' ] )
		else if ( stage.bgType === 'tornado' ) this._playVideo( '/tornado.mp4' )
		else                                    this._switchToColor()

		if ( stage.heavy ) this._lorenz.maxTrail = 30000
		if ( stage.mode !== 'chaos' ) this._initBlobs()
	}

	_popImage() {
		const wall = this._chaosWall
		if ( ! wall.pool.length ) return
		const url = wall.pool[ wall.poolIdx % wall.pool.length ]
		wall.poolIdx++
		const img = new Image()
		img.crossOrigin = 'anonymous'
		img.onload = () => {
			const isHeavy = TRACK[ this._trackStage ]?.heavy ?? false
			const aspect  = img.naturalWidth / ( img.naturalHeight || 1 )
			const w = isHeavy ? ( 120 + Math.random() * 120 ) : ( 50 + Math.random() * 70 )
			const h = w / aspect
			wall.active.push( {
				img,
				x:   Math.random() * innerWidth,
				y:   Math.random() * innerHeight,
				w, h,
				rot: 0,
				t0:  this.t,
			} )
			if ( wall.active.length > ( isHeavy ? 800 : 400 ) ) wall.active.shift()
		}
		img.src = url
	}

	init() {
		// ── Three.js background — video plane ou couleur unie ─────────────────
		const renderer = new THREE.WebGLRenderer( { antialias: false } )
		renderer.setPixelRatio( 1 )
		renderer.setSize( innerWidth, innerHeight )
		renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:0;display:block;'
		document.body.appendChild( renderer.domElement )

		const scene    = new THREE.Scene()
		const camera   = new THREE.OrthographicCamera( -1, 1, 1, -1, 0, 1 )
		const geo      = new THREE.PlaneGeometry( 2, 2 )
		const material = new THREE.MeshBasicMaterial( { color: 0x06060a } )
		const mesh     = new THREE.Mesh( geo, material )
		scene.add( mesh )

		const video = document.createElement( 'video' )
		video.loop   = true
		video.muted  = true
		video.setAttribute( 'playsinline', '' )

		this._three = { renderer, scene, camera, mesh, material, imageTexture: null, video, videoTexture: null }
		this._applyBgColor()

		// ── Canvas 2-D pour le rendu metaball (par-dessus le bg Three.js) ─────
		this.wrap = document.createElement( 'div' )
		this.wrap.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;'
		document.body.appendChild( this.wrap )

		this.canvas = document.createElement( 'canvas' )
		this.wrap.appendChild( this.canvas )
		this.ctx = this.canvas.getContext( '2d' )

		this._resize()
		addEventListener( 'resize', () => this._resize() )
		addEventListener( 'keydown', ( e ) => {
			if ( e.key === 'ArrowRight' ) this._advanceStage()
		} )

		this._updateFilter()
		this._reSample()
	}

	warmup() { this._draw() }

	play() {
		const loop = () => {
			this._draw()
			this._raf = requestAnimationFrame( loop )
		}
		this._raf = requestAnimationFrame( loop )
	}

	stop() {
		cancelAnimationFrame( this._raf )
		this._raf = null
	}

	// ── Internal ───────────────────────────────────────────────────────────────

	_resize() {
		const dpr = Math.min( devicePixelRatio, 2 )
		this.canvas.width  = innerWidth  * dpr
		this.canvas.height = innerHeight * dpr
		this.canvas.style.cssText = `display:block;width:${innerWidth}px;height:${innerHeight}px;`
		if ( this._three ) this._three.renderer.setSize( innerWidth, innerHeight )
	}

	_updateFilter( dynContraste ) {
		const { mode, flou, contraste } = this.params
		this.wrap.style.filter = ( mode === 'réseau' || mode === 'chaos' )
			? 'none'
			: `blur(${flou}px) contrast(${dynContraste ?? contraste})`
	}

	_renderThreeBg() {
		const t = this._three
		if ( ! t ) return
		if ( t.videoTexture ) t.videoTexture.needsUpdate = true
		t.renderer.render( t.scene, t.camera )
	}

	_reSample() {
		if ( ! this.imgData ) return
		this.samplePts   = []
		this.cumWeights  = []
		this.totalWeight = 0
		const { seuil } = this.params
		const step = 3
		for ( let py = 0; py < this.imgH; py += step ) {
			for ( let px = 0; px < this.imgW; px += step ) {
				const i = ( py * this.imgW + px ) * 4
				if ( this.imgData[ i + 3 ] < 30 ) continue           // transparent pixel
				const brightness = ( this.imgData[ i ] + this.imgData[ i + 1 ] + this.imgData[ i + 2 ] ) / 3
				const darkness   = 1 - brightness / 255
				if ( darkness < seuil ) continue
				const w = Math.sqrt( darkness )
				this.totalWeight += w
				this.samplePts.push( { normX: px / this.imgW, normY: py / this.imgH, darkness } )
				this.cumWeights.push( this.totalWeight )
			}
		}
		this._initBlobs()
	}

	_weightedSample() {
		const r  = Math.random() * this.totalWeight
		let lo   = 0
		let hi   = this.cumWeights.length - 1
		while ( lo < hi ) {
			const mid = ( lo + hi ) >> 1
			this.cumWeights[ mid ] < r ? ( lo = mid + 1 ) : ( hi = mid )
		}
		return this.samplePts[ lo ]
	}

	_initBlobs() {
		if ( ! this.samplePts.length ) return
		this.blobs = []
		const n = Math.round( this.params.blobs )
		for ( let i = 0; i < n; i++ ) {
			const p = this._weightedSample()
			this.blobs.push( {
				normX:      p.normX + ( Math.random() - 0.5 ) * 0.005,
				normY:      p.normY + ( Math.random() - 0.5 ) * 0.005,
				darkness:   p.darkness,
				baseR:      0.5 + Math.random() * 0.9,
				pulseFreq:  0.5 + Math.random() * 1.5,
				pulsePhase: Math.random() * Math.PI * 2,
				color:      PALETTE[ Math.floor( Math.random() * PALETTE.length ) ],
			} )
		}
	}

	// ── Drawing ────────────────────────────────────────────────────────────────

	_drawBlob( x, y, r, d, color ) {
		const size = r * ( 0.22 + 0.78 * d )
		const grad = this.ctx.createRadialGradient( x, y, 0, x, y, size )
		if ( this.params.mode === 'couleur' ) {
			grad.addColorStop( 0.00, color + 'ff' )
			grad.addColorStop( 0.50, color + 'ee' )
			grad.addColorStop( 1.00, color + '00' )
		} else {
			// dark on white - CSS blur+contrast snaps to clean metaballs
			grad.addColorStop( 0.00, 'hsla(220, 8%, 10%, 1.00)' )
			grad.addColorStop( 0.55, 'hsla(220, 6%, 12%, 0.85)' )
			grad.addColorStop( 1.00, 'hsla(220, 4%, 15%, 0.00)' )
		}
		this.ctx.beginPath()
		this.ctx.arc( x, y, size, 0, Math.PI * 2 )
		this.ctx.fillStyle = grad
		this.ctx.fill()
	}

	_drawReseau( dynVitesse, kickMult, freqs, dynDisplaySeuil ) {
		const { canvas, ctx, params, blobs, t } = this

		// temporal trail
		ctx.fillStyle = 'rgba(0, 0, 0, 0.07)'
		ctx.fillRect( 0, 0, canvas.width, canvas.height )
		if ( ! blobs.length ) return

		// audio-driven seuil (from _draw) + oscillation for réseau breathing
		const wave2     = Math.sin( t * 0.53 * dynVitesse + 1.3 )
		const dynCount  = Math.round( blobs.length * ( 1 - params.variation * 0.4 * ( wave2 * 0.5 + 0.5 ) ) )
		const active    = blobs.filter( b => b.darkness >= dynDisplaySeuil ).slice( 0, dynCount )

		const scale     = Math.min( canvas.width * 0.85 / this.imgW, canvas.height * 0.85 / this.imgH )
		const ox        = ( canvas.width  - this.imgW * scale ) / 2
		const oy        = ( canvas.height - this.imgH * scale ) / 2
		const minDist   = Math.min( canvas.width, canvas.height ) * 0.02
		const maxDist   = Math.min( canvas.width, canvas.height ) * 0.18
		const minDistSq = minDist * minDist
		const maxDistSq = maxDist * maxDist

		// positions with frequency-driven jitter
		const pts = active.map( b => {
			const binIdx    = Math.min( freqs.length - 1, Math.floor( b.normX * freqs.length * 0.8 ) )
			const freqJit   = 1 + freqs[ binIdx ] * 0.6 * kickMult
			return {
				x: b.normX * this.imgW * scale + ox
					+ Math.sin( t * b.pulseFreq * dynVitesse + b.pulsePhase ) * 5 * params.taille * freqJit,
				y: b.normY * this.imgH * scale + oy
					+ Math.cos( t * b.pulseFreq * dynVitesse * 0.7 + b.pulsePhase ) * 5 * params.taille * freqJit,
				d: b.darkness,
			}
		} )

		// arcs amples entre points éloignés
		for ( let i = 0; i < pts.length; i++ ) {
			let conn = 0
			for ( let j = i + 1; j < pts.length; j++ ) {
				if ( conn >= 2 ) break
				const dx     = pts[ j ].x - pts[ i ].x
				const dy     = pts[ j ].y - pts[ i ].y
				const distSq = dx * dx + dy * dy
				if ( distSq > minDistSq && distSq < maxDistSq ) {
					const dist  = Math.sqrt( distSq )
					const alpha = ( 1 - dist / maxDist ) * 0.25
					ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed( 3 )})`
					ctx.lineWidth   = 0.3
					const mx   = ( pts[ i ].x + pts[ j ].x ) / 2
					const my   = ( pts[ i ].y + pts[ j ].y ) / 2
					const sign = ( i + j ) % 2 === 0 ? 1 : -1
					const bend = dist * 1.3 * sign
					ctx.beginPath()
					ctx.moveTo( pts[ i ].x, pts[ i ].y )
					ctx.quadraticCurveTo(
						mx - ( dy / dist ) * bend,
						my + ( dx / dist ) * bend,
						pts[ j ].x, pts[ j ].y,
					)
					ctx.stroke()
					conn++
				}
			}
		}

		// dots
		for ( let i = 0; i < pts.length; i++ ) {
			const b = active[ i ]
			const r = ( 1.2 + b.darkness * 2.5 ) * params.taille * kickMult
			ctx.fillStyle = `rgba(255,255,255,${( 0.5 + b.darkness * 0.5 ).toFixed( 2 )})`
			ctx.beginPath()
			ctx.arc( pts[ i ].x, pts[ i ].y, r, 0, Math.PI * 2 )
			ctx.fill()
		}
	}

	_drawChaos( dynVitesse, kickMult, freqs ) {
		const { canvas, ctx } = this
		const a       = this.audio
		const l       = this._lorenz
		const wall    = this._chaosWall
		const dpr     = Math.min( devicePixelRatio, 2 )
		const isHeavy = TRACK[ this._trackStage ]?.heavy ?? false

		// clear canvas every frame — bgEl (color or video) shows through
		ctx.clearRect( 0, 0, canvas.width, canvas.height )

		// ── Intégration des équations de Lorenz (plusieurs pas par frame) ─────
		const σ  = 10, ρ = 28, β = 8 / 3
		const dt = 0.005 * ( 1 + a.volumeSmooth * 0.8 ) * dynVitesse
		for ( let s = 0; s < 5; s++ ) {
			const { x, y, z } = l
			l.x += σ * ( y - x ) * dt
			l.y += ( x * ( ρ - z ) - y ) * dt
			l.z += ( x * y - β * z ) * dt
			// vue classique papillon : projection (x, z) → écran
			const sx = ( l.x / 35 * 0.85 + 0.5 ) * canvas.width
			const sy = ( 1 - ( l.z - 2 ) / 58 ) * canvas.height * 0.88 + canvas.height * 0.06
			l.trail.push( [ sx, sy ] )
		}
		if ( l.trail.length > l.maxTrail ) l.trail.splice( 0, l.trail.length - l.maxTrail )

		// ── Tracé par buckets d'opacité (18 draw calls au lieu de 4000) ───────
		const trail   = l.trail
		const n       = trail.length
		const BUCKETS = 18
		if ( n > 2 ) {
			for ( let b = 0; b < BUCKETS; b++ ) {
				const i0  = Math.floor( b / BUCKETS * n )
				const i1  = Math.floor( ( b + 1 ) / BUCKETS * n )
				if ( i1 <= i0 ) continue
				const age   = ( b + 1 ) / BUCKETS
				const alpha = isHeavy ? Math.min( 1, age * age * 1.6 ) : age * age * 0.82
				const hue   = 28 + age * 28 + ( freqs[ Math.floor( age * 40 ) ] || 0 ) * 18
				ctx.beginPath()
				ctx.strokeStyle = `hsla(${hue.toFixed( 0 )}, 85%, ${( 38 + age * 26 ).toFixed( 0 )}%, ${alpha.toFixed( 3 )})`
				ctx.lineWidth   = isHeavy ? ( 1.5 + age * 7 * kickMult ) : ( 0.4 + age * 1.8 * kickMult )
				ctx.moveTo( trail[ i0 ][ 0 ], trail[ i0 ][ 1 ] )
				for ( let i = i0 + 1; i < i1; i++ ) ctx.lineTo( trail[ i ][ 0 ], trail[ i ][ 1 ] )
				ctx.stroke()
			}
		}

		// ── Pop image sur chaque kick ─────────────────────────────────────────
		if ( a.kick > 0.3 && this.t - wall.lastPop > ( isHeavy ? 0.4 : 1.5 ) ) {
			wall.lastPop = this.t
			const burst = isHeavy
				? ( a.kickHard > 0.35 ? 14 : 8 )
				: ( a.kickHard > 0.35 ? 4  : 2 )
			for ( let i = 0; i < burst; i++ ) this._popImage()
		}

		// ── Mur d'images par dessus le tracé ─────────────────────────────────
		for ( const im of wall.active ) {
			const progress = Math.min( 1, ( this.t - im.t0 ) / 8 )
			const ease     = 1 - Math.pow( 1 - progress, 3 )   // ease-out cubique
			const w = im.w * dpr
			const h = im.h * dpr
			const border = Math.max( 6, w * 0.04 )
			ctx.save()
			ctx.globalAlpha = ease
			ctx.translate( im.x * dpr, im.y * dpr )
			ctx.rotate( im.rot )
			ctx.scale( 0.4 + 0.6 * ease, 0.4 + 0.6 * ease )
			ctx.fillStyle = '#f0ece4'
			ctx.fillRect( -w / 2 - border, -h / 2 - border, w + border * 2, h + border * 2 )
			ctx.drawImage( im.img, -w / 2, -h / 2, w, h )
			ctx.restore()
		}
	}

	_draw() {
		const { canvas, ctx, params, blobs } = this
		const a = this.audio

		// ── track stage advancement — count significant kicks ────────────────
		if ( a.kick > 0.4 && this.t - this._lastKickTime > 10 ) {
			this._lastKickTime = this.t
			this._kickCount++
			const stage = TRACK[ this._trackStage ]
			if ( stage.kicksToNext && this._kickCount >= stage.kicksToNext ) {
				this._advanceStage()
			}
		}

		// ── sound-driven modulation ──────────────────────────────────────────
		// Pulse amplitude swells with loudness
		const dynPulseAmp = params.pulseAmp + a.volumeSmooth * 0.32
		// Speed increases with loudness
		const dynVitesse  = params.vitesse  * ( 1 + a.volumeSmooth * 0.7 )
		// Sharp size burst on kick
		const kickMult    = 1 + a.kick * 0.55 + a.kickHard * 0.35
		// Per-frequency bin values for per-blob reactivity
		const freqs       = a.volumeByFrequency

		// ── dynamic contraste: pulse sur kick, respire avec le volume ─────────
		const dynContraste = params.mode === 'mono'
			? params.contraste + a.volumeSmooth * 6 + a.kick * 5
			: params.mode === 'couleur'
				? params.contraste + a.volumeSmooth * 1.5 + a.kick * 1.2
				: params.contraste

		// ── dynamic display seuil: fort volume = tout le papillon visible ─────
		// Quiet (vol≈0): only dark blobs (body/veins) shown
		// Loud  (vol≈1): all sampled blobs shown (wing tips too)
		const dynDisplaySeuil = params.seuil + ( 1 - a.volumeSmooth ) * 0.45

		// update CSS filter every frame
		this._updateFilter( dynContraste )

		if ( params.mode === 'chaos' ) {
			this._drawChaos( dynVitesse, kickMult, freqs )
		} else if ( params.mode === 'réseau' ) {
			this._drawReseau( dynVitesse, kickMult, freqs, dynDisplaySeuil )
		} else {
			// mode mono: dark blobs on white → CSS blur+contrast makes crisp metaballs
			// mode couleur: colored blobs on dark → blur merges neighbouring colors
			// stages vidéo (sky/tornado): clearRect pour laisser le plan Three.js transparaître
			const bgType = TRACK[ this._trackStage ]?.bgType
			if ( bgType === 'sky' || bgType === 'tornado' ) {
				ctx.clearRect( 0, 0, canvas.width, canvas.height )
			} else {
				ctx.fillStyle = params.mode === 'couleur' ? '#0f0f14' : '#f4f4f0'
				ctx.fillRect( 0, 0, canvas.width, canvas.height )
			}

			if ( blobs.length ) {
				const scale = Math.min( canvas.width * 0.85 / this.imgW, canvas.height * 0.85 / this.imgH )
				const ox    = ( canvas.width  - this.imgW * scale ) / 2
				const oy    = ( canvas.height - this.imgH * scale ) / 2
				const base  = Math.min( canvas.width, canvas.height ) * 0.026 * params.taille

				for ( const b of blobs ) {
					// hide light-area blobs when music is quiet → reveal as volume rises
					if ( b.darkness < dynDisplaySeuil ) continue

					// map blob's horizontal position to a frequency bin
					// → left wing reacts to bass, right wing to highs
					const binIdx    = Math.min( freqs.length - 1, Math.floor( b.normX * freqs.length * 0.8 ) )
					const freqBoost = 1 + freqs[ binIdx ] * 0.55

					const pulse = ( 1 + dynPulseAmp * Math.sin( this.t * b.pulseFreq * dynVitesse + b.pulsePhase ) )
					             * freqBoost * kickMult

					const x = b.normX * this.imgW * scale + ox
					const y = b.normY * this.imgH * scale + oy
					this._drawBlob( x, y, b.baseR * base * pulse, b.darkness, b.color )
				}
			}
		}

		this._renderThreeBg()
		this.t += 0.16
	}

}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const audio = new Analyzer()
const scene = new ButterflyBlobsScene( audio )

audio.onLoad( async () => {
	await scene.load()
	scene.init()
} )
audio.onWarmup( () => scene.warmup() )
audio.onPlay(   () => scene.play()   )
audio.onStop(   () => scene.stop()   )
