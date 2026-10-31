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
    // 挂勺/取勺只动右臂和腰槽，不锁根位移
    case 'stow_scoop':return ['right_arm','item:rice_scoop','waist_slot'];
    case 'unstow_scoop':return ['right_arm','item:rice_scoop','waist_slot'];
    // 抱棋：根位移、双臂、该棋子和公共持棋锚点全部占用，不能与走路/手势/挂取勺并行
    case 'xiangqi_move':return ['body_locomotion','left_arm','right_arm','both_hands','chess_carry',`item:${step.piece_id??'piece'}`];
    default:return [];
  }
}
export function parallelConflict(items){const used=new Set();for(const item of items){for(const key of resources(item)){if(used.has(key))return key;used.add(key);}}return null;}
