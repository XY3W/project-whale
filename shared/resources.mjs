export function resources(step) {
  switch(step.action){
    case 'turn':case 'walk':case 'run':case 'walk_adjust':return ['body_locomotion'];
    case 'play':return ['left_arm','right_arm'];
    case 'tail':return ['tail'];case 'wait':return [];
    case 'set_basin_grip':return ['body_locomotion','left_arm','item:basin'];
    case 'knock_basin':return ['body_locomotion','left_arm','right_arm','item:basin','item:rice_scoop'];
    case 'dig':return ['body_locomotion','right_arm','item:rice_scoop'];
    case 'walk_to_basin':return ['body_locomotion','left_arm','right_arm'];
    case 'pickup':case 'throw':case 'wear':case 'unwear':return ['body_locomotion',step.object_id==='basin'?'left_arm':'right_arm',`item:${step.object_id}`,...(['wear','unwear'].includes(step.action)?['head_attachment']:[])];
    default:return [];
  }
}
export function parallelConflict(items){const used=new Set();for(const item of items){for(const key of resources(item)){if(used.has(key))return key;used.add(key);}}return null;}
