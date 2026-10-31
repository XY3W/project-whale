/** Accepted material blink model; original head geometry and all authored body clips are preserved. */
/**
 * 中国象棋版角色副本：原 blink-material-v2 的全部网格/蒙皮/材质/45 段动作原样保留，
 * 只追加 16 段象棋动作（stow_scoop / chess_*）。素材契约要求首版直接用完整新副本，
 * 避免跨模型动作重绑定。
 */
export const CHARACTER_MODEL = '/models/xiangqi-v1/character_xiangqi.glb';
export const CHARACTER_MODEL_LEGACY = '/models/blink-material-v2/character_material_only.glb';
