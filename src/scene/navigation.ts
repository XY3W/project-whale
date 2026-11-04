/** Floor navigation uses furniture footprints expanded by the character radius. */
export interface Point2 { x: number; z: number }
export interface Obstacle { minX: number; maxX: number; minZ: number; maxZ: number }
export interface SceneCollider { x: number; y: number; z: number; hx: number; hy: number; hz: number }
export const CHARACTER_RADIUS = 0.18;
export function expandObstacle(o: Obstacle, margin = CHARACTER_RADIUS): Obstacle {
  return {minX:o.minX-margin,maxX:o.maxX+margin,minZ:o.minZ-margin,maxZ:o.maxZ+margin};
}
export function inside(p: Point2, o: Obstacle) {
  return p.x > o.minX && p.x < o.maxX && p.z > o.minZ && p.z < o.maxZ;
}

/** Old saves may contain a standing root inside furniture (including a refreshed resting pose). */
export function recoverPosition(p: Point2, raw: Obstacle[], candidates: Point2[]): Point2 {
  const obstacles = raw.map(o=>expandObstacle(o));
  if (!obstacles.some(o=>inside(p,o))) return {x:p.x,z:p.z};
  const valid = candidates.filter(q=>!obstacles.some(o=>inside(q,o)));
  valid.sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z));
  return valid[0] ? {...valid[0]} : {x:p.x,z:p.z};
}
/** Slab test covers the whole segment, including large frame displacements. */
export function segmentBlocked(a: Point2, b: Point2, obstacles: Obstacle[]) {
  return obstacles.some(o => {
    let lo=0,hi=1;
    for (const axis of ['x','z'] as const) {
      const min=axis==='x'?o.minX:o.minZ,max=axis==='x'?o.maxX:o.maxZ,d=b[axis]-a[axis];
      if(Math.abs(d)<1e-10){if(a[axis]<=min||a[axis]>=max)return false;continue;}
      const t1=(min-a[axis])/d,t2=(max-a[axis])/d;
      lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
      if(lo>=hi-1e-9)return false;
    }
    return lo<hi-1e-9;
  });
}
/** Visibility graph around box corners, without a grid or a dependency on LLM path arithmetic. */
export function navigationPath(from: Point2, to: Point2, raw: Obstacle[], half: number): Point2[] | null {
  const obstacles=raw.map(o=>expandObstacle(o,CHARACTER_RADIUS+.035));
  const valid=(p:Point2)=>Math.abs(p.x)<=half&&Math.abs(p.z)<=half&&!obstacles.some(o=>inside(p,o));
  if(!valid(from)||!valid(to))return null;
  const nodes:Point2[]=[from,to];
  for(const o of obstacles)for(const x of [o.minX-.001,o.maxX+.001])for(const z of [o.minZ-.001,o.maxZ+.001]){
    const p={x,z};if(valid(p))nodes.push(p);
  }
  const dist=nodes.map(()=>Infinity),prev=nodes.map(()=>-1),done=new Set<number>();dist[0]=0;
  while(done.size<nodes.length){
    let u=-1;for(let i=0;i<nodes.length;i++)if(!done.has(i)&&(u<0||dist[i]<dist[u]))u=i;
    if(u<0||!Number.isFinite(dist[u]))return null;
    if(u===1){const out:Point2[]=[];for(let i=1;i>0;i=prev[i])out.unshift({...nodes[i]});return out;}
    done.add(u);
    for(let v=0;v<nodes.length;v++)if(!done.has(v)&&!segmentBlocked(nodes[u],nodes[v],obstacles)){
      const d=dist[u]+Math.hypot(nodes[v].x-nodes[u].x,nodes[v].z-nodes[u].z);
      if(d<dist[v]){dist[v]=d;prev[v]=u;}
    }
  }
  return null;
}
