import * as THREE from "three";

/**
 * 让 three 的标准材质支持最多 16 个骨骼影响（JOINTS_0..3 / WEIGHTS_0..3）。
 *
 * 两个必须做的修正：
 * 1. GLTFLoader 会先把第一组权重归一化，必须恢复原始值，否则组间比例被破坏
 * 2. three 的蒙皮不归一化权重，截断后要除以已使用权重的总和
 */

function bodyChunk(sets: number): string {
  let glsl = `#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
  vec4 skinned = vec4( 0.0 );
  skinned += boneMatX * skinVertex * skinWeight.x;
  skinned += boneMatY * skinVertex * skinWeight.y;
  skinned += boneMatZ * skinVertex * skinWeight.z;
  skinned += boneMatW * skinVertex * skinWeight.w;
`;
  for (let i = 1; i < sets; i++) {
    glsl += `  skinned += getBoneMatrix( skinIndex${i}.x ) * skinVertex * skinWeight${i}.x;
  skinned += getBoneMatrix( skinIndex${i}.y ) * skinVertex * skinWeight${i}.y;
  skinned += getBoneMatrix( skinIndex${i}.z ) * skinVertex * skinWeight${i}.z;
  skinned += getBoneMatrix( skinIndex${i}.w ) * skinVertex * skinWeight${i}.w;
`;
  }
  glsl += `  float wsum = dot( skinWeight, vec4( 1.0 ) )`;
  for (let i = 1; i < sets; i++) glsl += ` + dot( skinWeight${i}, vec4( 1.0 ) )`;
  glsl += `;
  skinned /= max( wsum, 1e-5 );
  transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`;
  return glsl;
}

function normalChunk(sets: number): string {
  let glsl = `#ifdef USE_SKINNING
  mat4 skinMatrix = mat4( 0.0 );
  skinMatrix += skinWeight.x * boneMatX;
  skinMatrix += skinWeight.y * boneMatY;
  skinMatrix += skinWeight.z * boneMatZ;
  skinMatrix += skinWeight.w * boneMatW;
`;
  for (let i = 1; i < sets; i++) {
    glsl += `  skinMatrix += skinWeight${i}.x * getBoneMatrix( skinIndex${i}.x );
  skinMatrix += skinWeight${i}.y * getBoneMatrix( skinIndex${i}.y );
  skinMatrix += skinWeight${i}.z * getBoneMatrix( skinIndex${i}.z );
  skinMatrix += skinWeight${i}.w * getBoneMatrix( skinIndex${i}.w );
`;
  }
  glsl += `  skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
  objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
  #ifdef USE_TANGENT
    objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
  #endif
#endif`;
  return glsl;
}

function patch(mat: THREE.Material, sets: number) {
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    let decl = "";
    for (let i = 1; i < sets; i++) decl += `attribute vec4 skinIndex${i};\nattribute vec4 skinWeight${i};\n`;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + decl)
      .replace("#include <skinning_vertex>", bodyChunk(sets))
      .replace("#include <skinnormal_vertex>", normalChunk(sets));
  };
  m.customProgramCacheKey = () => `skin-sets-${sets}`;
  m.needsUpdate = true;
}

export async function enableMultiWeight(gltf: { parser?: any }, meshes: THREE.SkinnedMesh[]) {
  const parser = gltf.parser;
  for (const mesh of meshes) {
    const g = mesh.geometry;
    if (!(g.getAttribute("weights_1") ?? g.getAttribute("WEIGHTS_1"))) continue;

    let sets = 1;
    for (let i = 1; i < 4; i++) {
      const ji = g.getAttribute(`joints_${i}`) ?? g.getAttribute(`JOINTS_${i}`);
      const wi = g.getAttribute(`weights_${i}`) ?? g.getAttribute(`WEIGHTS_${i}`);
      if (!ji || !wi) break;
      g.setAttribute(`skinIndex${i}`, new THREE.BufferAttribute(Float32Array.from(ji.array as ArrayLike<number>), 4));
      g.setAttribute(`skinWeight${i}`, new THREE.BufferAttribute(Float32Array.from(wi.array as ArrayLike<number>), 4));
      sets++;
    }

    // 恢复第一组原始权重
    const assoc = parser?.associations?.get(mesh);
    if (parser && assoc?.meshes !== undefined) {
      const prim = parser.json.meshes[assoc.meshes].primitives[assoc.primitives];
      const idx = prim?.attributes?.WEIGHTS_0;
      if (idx !== undefined) {
        // Accessor cache shares the array already normalized by GLTFLoader.
        // Read the original buffer: cached accessors AND buffer views may share mutated arrays.
        const accessor = parser.json.accessors[idx];
        const bufferView = parser.json.bufferViews[accessor.bufferView];
        if (accessor.sparse) throw new Error("Sparse multi-weight accessors need expansion before loading");
        const bytes: ArrayBuffer = await parser.getDependency("buffer", bufferView.buffer);
        const data = new DataView(bytes);
        const size = accessor.componentType === 5126 ? 4 : accessor.componentType === 5123 ? 2 : 1;
        const stride = bufferView.byteStride ?? size * 4;
        const restored = new Float32Array(accessor.count * 4);
        for (let vertex = 0; vertex < accessor.count; vertex++) {
          for (let channel = 0; channel < 4; channel++) {
            const offset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + vertex * stride + channel * size;
            let value: number;
            if (accessor.componentType === 5126) value = data.getFloat32(offset, true);
            else if (accessor.componentType === 5123) value = data.getUint16(offset, true) / (accessor.normalized ? 65535 : 1);
            else if (accessor.componentType === 5121) value = data.getUint8(offset) / (accessor.normalized ? 255 : 1);
            else throw new Error("Unsupported skin weight component type");
            restored[vertex * 4 + channel] = value;
          }
        }
        g.setAttribute("skinWeight", new THREE.BufferAttribute(restored, 4));
      }
    }

    // Fail visibly if first-group normalization was not actually undone.
    let maxWeightSumError = 0;
    for (let vertex = 0; vertex < g.getAttribute("skinWeight").count; vertex++) {
      let total = 0;
      for (let group = 0; group < sets; group++) {
        const weights = g.getAttribute(group === 0 ? "skinWeight" : `skinWeight${group}`);
        total += weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
      }
      maxWeightSumError = Math.max(maxWeightSumError, Math.abs(total - 1));
    }
    if (maxWeightSumError > 1e-4) throw new Error(`Invalid full skin weights on ${mesh.name}: ${maxWeightSumError}`);
    console.info("Full skin weights verified", mesh.name, sets, maxWeightSumError);

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => patch(m, sets));

    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patch(depth, sets);
    mesh.customDepthMaterial = depth;
    const distance = new THREE.MeshDistanceMaterial();
    patch(distance, sets);
    mesh.customDistanceMaterial = distance;
    mesh.castShadow = true;
  }
}
