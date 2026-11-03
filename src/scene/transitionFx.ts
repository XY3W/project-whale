import * as THREE from "three";

/**
 * 场景切换的落点特效：一圈地面光环 + 一小把向上飘的粒子。
 * 只是装饰层，不参与拾取与物理。
 */
export class PoofFx {
  private readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly velocities: Float32Array;
  private readonly ring: THREE.Mesh;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly capacity: number;
  private life = 0;
  private ringLife = 0;
  private readonly duration = 0.7;
  private readonly ringDuration = 0.5;

  constructor(scene: THREE.Scene, capacity = 64) {
    this.capacity = capacity;
    const positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.material = new THREE.PointsMaterial({
      color: 0xa8d4ff,
      size: 0.035,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;

    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fd0ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 40), this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;

    scene.add(this.points, this.ring);
  }

  /** 在 position 处炸开一簇粒子，并在地面画一圈光。 */
  burst(position: THREE.Vector3, color = 0xa8d4ff) {
    const attr = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.capacity; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.02 + Math.random() * 0.08;
      const up = 0.25 + Math.random() * 0.55;
      attr.setXYZ(i, position.x + Math.cos(angle) * radius, position.y + 0.02, position.z + Math.sin(angle) * radius);
      this.velocities[i * 3] = Math.cos(angle) * (0.25 + Math.random() * 0.5);
      this.velocities[i * 3 + 1] = up;
      this.velocities[i * 3 + 2] = Math.sin(angle) * (0.25 + Math.random() * 0.5);
    }
    attr.needsUpdate = true;
    this.material.color.setHex(color);
    this.material.opacity = 1;
    this.points.visible = true;
    this.life = 1;

    this.ring.position.set(position.x, 0.012, position.z);
    this.ring.scale.setScalar(0.6);
    this.ringMaterial.color.setHex(color);
    this.ringMaterial.opacity = 0.85;
    this.ring.visible = true;
    this.ringLife = 1;
  }

  update(dt: number) {
    if (this.life > 0) {
      this.life = Math.max(0, this.life - dt / this.duration);
      const attr = this.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < this.capacity; i++) {
        this.velocities[i * 3 + 1] -= 0.6 * dt;
        attr.setXYZ(
          i,
          attr.getX(i) + this.velocities[i * 3] * dt,
          Math.max(0.02, attr.getY(i) + this.velocities[i * 3 + 1] * dt),
          attr.getZ(i) + this.velocities[i * 3 + 2] * dt,
        );
        this.velocities[i * 3] *= 0.96;
        this.velocities[i * 3 + 2] *= 0.96;
      }
      attr.needsUpdate = true;
      this.material.opacity = this.life;
      if (this.life === 0) this.points.visible = false;
    }
    if (this.ringLife > 0) {
      this.ringLife = Math.max(0, this.ringLife - dt / this.ringDuration);
      const k = 1 - this.ringLife;
      this.ring.scale.setScalar(0.6 + k * 2.2);
      this.ringMaterial.opacity = this.ringLife * 0.85;
      if (this.ringLife === 0) this.ring.visible = false;
    }
  }
}
