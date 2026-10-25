import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Stage } from "./core/Stage";
import { enableMultiWeight } from "./character/multiWeight";
import { LayeredMotionPlayer } from "./character/LayeredMotionPlayer";
import { BasinProp, type ThrowSpec } from "./prop/BasinProp";
import { loadBasinAssets, type BasinCatalog } from "./prop/catalog";

const BASE = "/models/basin-v2";
const norm = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");
const clamp = THREE.MathUtils.clamp;

const sections = document.getElementById("sections")!;
const panel = document.getElementById("panel")!;

function section(title: string): HTMLElement {
  const element = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  element.appendChild(heading);
  sections.appendChild(element);
  return element;
}

function row(parent: HTMLElement): HTMLElement {
  const element = document.createElement("div");
  element.className = "row";
  parent.appendChild(element);
  return element;
}

function hint(parent: HTMLElement, text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "hint";
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function button(parent: HTMLElement, label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  if (title) element.title = title;
  element.onclick = onClick;
  parent.appendChild(element);
  return element;
}

async function boot() {
  const stage = new Stage(document.getElementById("app")!);
  const loader = new GLTFLoader();
  const [assets, charGltf, basinGltf] = await Promise.all([
    loadBasinAssets(BASE),
    loader.loadAsync(`${BASE}/character_basin_actions.glb`),
    loader.loadAsync(`${BASE}/steel_basin_v2.glb`),
  ]);
  const catalog: BasinCatalog = assets.catalog;

  const root = new THREE.Group();
  root.add(charGltf.scene);
  stage.scene.add(root);
  const box = new THREE.Box3().setFromObject(charGltf.scene);
  root.position.y = -box.min.y;

  const meshes: THREE.SkinnedMesh[] = [];
  charGltf.scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if ((mesh as THREE.Mesh).isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (mesh.isSkinnedMesh) meshes.push(mesh);
    }
  });
  await enableMultiWeight(charGltf as never, meshes);

  // ---- 形态键 ----
  const morphTargets = new Map<string, THREE.Mesh[]>();
  charGltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const dict = mesh.morphTargetDictionary;
    if (!dict) return;
    for (const name of Object.keys(dict)) {
      const list = morphTargets.get(name) ?? [];
      list.push(mesh);
      morphTargets.set(name, list);
    }
  });
  const setMorph = (name: string, value: number) => {
    for (const mesh of morphTargets.get(name) ?? []) {
      const index = mesh.morphTargetDictionary![name];
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
    }
  };
  const setTuck = (value: number) => setMorph(catalog.wearMorph, value);

  const bones = new Map<string, THREE.Bone>();
  charGltf.scene.traverse((object) => {
    if ((object as THREE.Bone).isBone) bones.set(norm(object.name), object as THREE.Bone);
  });

  const player = new LayeredMotionPlayer(root, charGltf.animations);
  const holdClip = charGltf.animations.find((clip) => clip.name === "hold_basin") ?? null;
  if (holdClip) player.setHoldClip(holdClip);

  const basin = await BasinProp.create({
    catalog,
    propMotion: assets.propMotion,
    charRoot: root,
    scene: basinGltf.scene,
    bones,
    setMorph: setTuck,
    parent: stage.scene,
  });
  basin.resetToReference();

  // ---- 相机 ----
  stage.setRoomCamera();
  stage.controls.minDistance = 1.2;
  stage.controls.maxDistance = 7;
  const focusY = 0.55;
  const setView = (x: number, y: number, z: number) => {
    stage.controls.target.set(root.position.x, focusY, root.position.z);
    stage.camera.position.set(root.position.x + x, focusY + y, root.position.z + z);
    stage.controls.update();
  };
  setView(1.35, 0.72, 3.15);

  // ---- 日志 ----
  const logEl = document.createElement("div");
  logEl.id = "log";
  const log = (text: string) => {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    logEl.textContent = `${stamp}  ${text}\n${logEl.textContent ?? ""}`.slice(0, 2000);
  };

  // ---- 状态面板 ----
  const statusSection = section("状态");
  const stats = document.createElement("dl");
  const stat = (label: string) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = "—";
    stats.append(dt, dd);
    return dd;
  };
  const statClip = stat("播放");
  const statLayer = stat("分层");
  const statBasin = stat("钢盆");
  const statPerf = stat("性能");
  statusSection.appendChild(stats);
  statusSection.appendChild(logEl);

  // ---- 基础移动 ----
  const moveSection = section("基础移动");
  const moveRow = row(moveSection);
  button(moveRow, "待机", () => {
    player.stopSolo();
    player.clearGesture();
    player.setWalking(false);
  });
  for (const meters of [0.09, 0.27, 0.45, 1.17, 1.89]) {
    button(
      moveRow,
      `走 ${meters}`,
      () => {
        player.stopSolo();
        if (!player.walkDistance(meters)) log(`不支持的距离 ${meters}`);
      },
      "起步 0.8s + n×1.6s + 收步 0.8s（实时长度）",
    );
  }
  button(moveRow, "回原点", () => {
    player.stopSolo();
    player.setWalking(false);
    root.position.set(0, root.position.y, 0);
    root.rotation.y = 0;
  });
  hint(moveSection, "行走会真的移动角色，相机默认跟随。");

  // ---- 上身 ----
  const upperSection = section("上身动作");
  const upperRow = row(upperSection);
  for (const [label, id] of [
    ["挥手", "greet"],
    ["注意", "notice"],
    ["点头", "nod"],
    ["看左", "look_left"],
    ["看右", "look_right"],
    ["思考", "think"],
  ] as const) {
    button(upperRow, label, () => {
      player.stopSolo();
      player.gesture(id);
    });
  }
  button(upperRow, "清除", () => player.clearGesture());

  // ---- 尾巴 ----
  const tailSection = section("尾巴");
  const tailRow = row(tailSection);
  const tailIdle = button(tailRow, "轻摆尾", () => {
    player.stopSolo();
    player.setTail(false);
    tailIdle.classList.add("active");
    tailSwish.classList.remove("active");
  });
  const tailSwish = button(tailRow, "大摆尾", () => {
    player.stopSolo();
    player.setTail(true);
    tailSwish.classList.add("active");
    tailIdle.classList.remove("active");
  });
  tailIdle.classList.add("active");

  // ---- 钢盆 ----
  const basinSection = section("钢盆互动");
  const basinRow = row(basinSection);
  const playBasin = async (id: string, spec?: ThrowSpec) => {
    if (player.solo) player.stopSolo();
    if (!basin.begin(id, spec)) {
      log(`不能执行 ${id}（当前 ${basin.state}）`);
      return;
    }
    const events = (catalog.actions.find((action) => action.id === id)?.events ?? []).map((event) => ({
      time: event.time,
      type: event.type,
    }));
    const ok = await player.perform(id, events, (type) => {
      basin.handleEvent(type);
      log(`${id} · ${type} @ ${player.performanceTime.toFixed(2)}s`);
    });
    basin.finish(ok);
    log(`${id} 结束 · state=${basin.state}`);
  };
  button(basinRow, "拾取", () => void playBasin("pickup_basin"));
  button(basinRow, "戴上", () => void playBasin("wear_basin"));
  button(basinRow, "取下", () => void playBasin("unwear_basin"));
  button(basinRow, "投掷", () => void playBasin("throw_basin", { directionDeg: 0, speed: 3.2, spin: 180 }));
  button(basinRow, "扶正", () => {
    if (basin.state !== "resting") {
      log(`扶正失败：盆当前是 ${basin.state}，只有静止在地面才能扶正`);
      return;
    }
    if (basin.upright) {
      log("盆已经是正放的");
      return;
    }
    const result = basin.startUpright(0.45);
    log(`扶正 moved=${result.moved}m 旋转=${result.rotatedDeg}° ok=${result.ok}`);
  });
  button(basinRow, "摆成侧躺", () => {
    basin.tiltOver();
    log("盆已摆成侧躺");
  });
  button(basinRow, "复位（相对角色）", () => {
    basin.resetToReference();
    setTuck(0);
    log("盆已复位到标准站位");
  });
  button(basinRow, "场地中心", () => {
    basin.resetToCenter();
    setTuck(0);
    log("盆已放回场地中心");
  });
  hint(basinSection, "拾取以标准站位为参考：先“回原点”再复位，动作才和手对得上。单片段检查钢盆片段时，盆会按片段时刻自动摆到手上/头上。");

  // ---- 逐片段检查 ----
  const clipSection = section("逐片段检查");
  const select = document.createElement("select");
  const clipNames = charGltf.animations.map((clip) => clip.name);
  const clipDuration = (name: string) => charGltf.animations.find((clip) => clip.name === name)?.duration ?? 1;
  for (const name of clipNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name}（${clipDuration(name).toFixed(2)}s）`;
    select.appendChild(option);
  }
  clipSection.appendChild(select);

  const controlRow = row(clipSection);
  const loopBox = document.createElement("label");
  loopBox.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;color:#5b6884;margin-left:2px";
  const loopInput = document.createElement("input");
  loopInput.type = "checkbox";
  loopBox.append(loopInput, document.createTextNode("循环"));
  controlRow.appendChild(loopBox);
  const pauseButton = button(controlRow, "暂停", () => {
    const solo = player.solo;
    if (!solo) return;
    player.setSoloPaused(!solo.paused);
  });
  button(controlRow, "退出单片段", () => {
    player.stopSolo();
    log("退出单片段检查");
  });

  const sliderRow = document.createElement("div");
  sliderRow.className = "slider-row";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.005";
  slider.value = "0";
  const timeLabel = document.createElement("span");
  timeLabel.textContent = "—";
  sliderRow.append(slider, timeLabel);
  clipSection.appendChild(sliderRow);
  const eventLine = hint(clipSection, "");

  const eventsOf = (name: string): { time: number; type: string }[] =>
    (catalog.actions.find((action) => action.id === name)?.events ?? []).map((event) => ({
      time: event.time,
      type: event.type,
    }));

  const paintEvents = (name: string) => {
    const events = eventsOf(name);
    eventLine.textContent = events.length
      ? `事件：${events.map((event) => `${event.time.toFixed(2)}s ${event.type}`).join(" · ")}`
      : "该片段没有物品事件";
    slider.max = String(clipDuration(name));
  };

  const startSolo = () => {
    const name = select.value;
    if (!player.soloClip(name, { loop: loopInput.checked })) {
      log(`找不到片段 ${name}`);
      return;
    }
    slider.value = "0";
    paintEvents(name);
    log(`单片段：${name}`);
  };

  select.onchange = startSolo;
  slider.oninput = () => {
    if (!player.solo) startSolo();
    player.setSoloTime(Number(slider.value));
  };
  button(controlRow, "重播", () => {
    if (player.solo) {
      player.setSoloTime(0);
      player.setSoloPaused(false);
    } else startSolo();
  });
  loopInput.onchange = () => startSolo();

  const clipGroups: Array<[string, string[]]> = [
    ["分层片段", clipNames.filter((name) => name.includes("."))],
    ["上身片段", ["greet", "notice", "nod", "look_left", "look_right", "think"].filter((name) => clipNames.includes(name))],
    ["尾巴片段", ["tail_idle", "tail_swish"].filter((name) => clipNames.includes(name))],
    ["钢盆片段", ["pickup_basin", "hold_basin", "wear_basin", "unwear_basin", "throw_basin"].filter((name) => clipNames.includes(name))],
  ];
  for (const [label, names] of clipGroups) {
    if (!names.length) continue;
    const caption = document.createElement("p");
    caption.className = "hint";
    caption.textContent = label;
    clipSection.appendChild(caption);
    const groupRow = row(clipSection);
    for (const name of names) {
      button(groupRow, name.replace(".upperBase", "·上").replace(".lower", "·下"), () => {
        select.value = name;
        startSolo();
      });
    }
  }
  paintEvents(select.value);

  // ---- 形态键 ----
  const morphSection = section("形态键");
  const morphLabels = new Map<string, HTMLSpanElement>();
  for (const name of morphTargets.keys()) {
    const wrapper = document.createElement("div");
    wrapper.className = "slider-row";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = "0";
    const label = document.createElement("span");
    label.textContent = `${name} 0.00`;
    input.oninput = () => {
      const value = Number(input.value);
      label.textContent = `${name} ${value.toFixed(2)}`;
      setMorph(name, value);
    };
    wrapper.append(input, label);
    morphSection.appendChild(wrapper);
    morphLabels.set(name, label);
  }
  const morphRow = row(morphSection);
  button(morphRow, "全部清零", () => {
    for (const name of morphTargets.keys()) {
      setMorph(name, 0);
      const label = morphLabels.get(name);
      if (label) label.textContent = `${name} 0.00`;
    }
    for (const input of morphSection.querySelectorAll<HTMLInputElement>("input")) input.value = "0";
    log("形态键已清零");
  });

  // ---- 相机 ----
  const cameraSection = section("相机");
  const cameraRow = row(cameraSection);
  button(cameraRow, "正面", () => setView(0, 0.7, 3.1));
  button(cameraRow, "45°", () => setView(1.35, 0.72, 3.15));
  button(cameraRow, "侧面", () => setView(3.1, 0.65, 0));
  button(cameraRow, "背面", () => setView(0, 0.7, -3.1));
  const followLabel = document.createElement("label");
  followLabel.style.cssText = "display:flex;align-items:center;gap:4px;font-size:12px;color:#5b6884";
  const followInput = document.createElement("input");
  followInput.type = "checkbox";
  followInput.checked = true;
  followLabel.append(followInput, document.createTextNode("跟随角色"));
  cameraRow.appendChild(followLabel);

  // ---- 主循环 ----
  const clock = new THREE.Clock();
  let frames = 0;
  let fpsAt = performance.now();
  let lastPaint = 0;

  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    player.update(dt);
    if (!player.solo && player.movementDelta > 0) {
      root.position.x += Math.sin(root.rotation.y) * player.movementDelta;
      root.position.z += Math.cos(root.rotation.y) * player.movementDelta;
      root.position.x = clamp(root.position.x, -3.7, 3.7);
      root.position.z = clamp(root.position.z, -3.7, 3.7);
    }
    root.updateMatrixWorld(true);
    // 单片段检查钢盆片段时，按片段时刻预览挂接（不动状态机）
    const soloNow = player.solo;
    if (soloNow && soloNow.name.endsWith("_basin")) basin.previewAt(soloNow.name, soloNow.time);
    else basin.previewAt(null, 0);
    basin.update(dt, player.performanceTime);
    player.setHoldEnabled(basin.mode === "hand" && (!player.performing || player.performanceEnding));

    if (followInput.checked) {
      const offset = stage.camera.position.clone().sub(stage.controls.target);
      stage.controls.target.set(root.position.x, focusY, root.position.z);
      stage.camera.position.copy(stage.controls.target).add(offset);
    }
    stage.update();

    const solo = player.solo;
    if (solo) {
      if (document.activeElement !== slider) slider.value = String(solo.time);
      timeLabel.textContent = `${solo.time.toFixed(2)} / ${solo.duration.toFixed(2)}s`;
      pauseButton.textContent = solo.paused ? "继续" : "暂停";
    } else {
      timeLabel.textContent = "—";
      pauseButton.textContent = "暂停";
    }

    frames++;
    const now = performance.now();
    if (now - lastPaint > 200) {
      const fps = (frames * 1000) / Math.max(1, now - fpsAt);
      if (now - fpsAt > 1000) {
        frames = 0;
        fpsAt = now;
      }
      lastPaint = now;
      statClip.textContent = solo
        ? `${solo.name} ${solo.time.toFixed(2)}/${solo.duration.toFixed(2)}s${solo.paused ? "（暂停）" : ""}`
        : player.performing
          ? `${player.performing}（互动）`
          : "分层状态机";
      statLayer.textContent = `${player.state.base} · 上身 ${player.state.upper ?? "—"} · ${player.state.tail === "tail_idle" ? "轻摆尾" : "大摆尾"}`;
      const snapshot = basin.snapshot();
      statBasin.textContent = `${snapshot.state}${snapshot.holder ? ` · ${snapshot.holder}` : ""} · ${snapshot.upright ? "正放" : "倾斜"} · rev ${snapshot.revision}`;
      statPerf.textContent = `${fps.toFixed(1)} fps · ${charGltf.animations.length} 段 · ${bones.size} 骨 · ${meshes.length} 网格`;
    }
  });

  addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === "Space" && player.solo) {
      event.preventDefault();
      player.setSoloPaused(!player.solo.paused);
    }
  });

  const footer = section("跳转");
  const footerRow = row(footer);
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "← 返回主页面";
  back.style.cssText = "font-size:12px;color:#3d62ad;margin-right:12px;align-self:center";
  const sandbox = document.createElement("a");
  sandbox.href = "/basin.html";
  sandbox.textContent = "钢盆沙盒 →";
  sandbox.style.cssText = "font-size:12px;color:#3d62ad;align-self:center";
  footerRow.append(back, sandbox);

  log(`载入完成：${charGltf.animations.length} 段片段、${bones.size} 骨、${meshes.length} 网格、${morphTargets.size} 个形态键`);
  (window as unknown as Record<string, unknown>).debugStage = { stage, root, player, basin, catalog };
}

boot().catch((error) => {
  console.error(error);
  panel.insertAdjacentHTML("beforeend", `<p style="color:#b12038">加载失败：${String(error)}</p>`);
});
