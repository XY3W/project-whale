/**
 * "持续动作"名单。
 *
 * 持续动作（坐下、躺下、以后的睡觉/泡澡…）一旦生效，主循环就不跑随机游走，
 * 直到它被主动结束（起身）或被新的移动/动作打断。
 * 服务端用同一份名单告诉模型"这个动作会让宿主暂停自主漫游"。
 */
export const PERSISTENT_ACTIONS = new Set(["use_furniture"]);

export const isPersistentAction = (action) => PERSISTENT_ACTIONS.has(action);
