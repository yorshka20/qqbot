/**
 * One-shot rename of VRM clip files under `assets/clips/vrm/` into a unified
 * `<category>_<intent>[_<modifier>][_NN].json` scheme.
 *
 * Steps performed:
 *   1. `git mv` each old name -> new name (history-preserving)
 *   2. Rewrite each clip's internal `id` field to match the new stem
 *   3. Caller should re-run `bun run scripts/generate-vrm-extend-action-map.ts`
 *
 * Run from `packages/avatar`:
 *   bun run scripts/rename-vrm-clips.ts
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const clipsDir = join(__dir, '../assets/clips/vrm');

// old filename (without ".json") -> new filename (without ".json")
const RENAMES: Record<string, string> = {
  // --- idle / standby ---
  WAIT00: 'idle_wait_01',
  WAIT01: 'idle_wait_02',
  WAIT02: 'idle_wait_03',
  WAIT03: 'idle_wait_04',
  WAIT04: 'idle_wait_05',
  Female_Standby9: 'idle_standby_w_01',
  Female_Standby10: 'idle_standby_w_02',
  Hub_Idle01: 'idle_hub_01',
  Hub_Idle02: 'idle_hub_02',
  Hub_Idle03: 'idle_hub_03',
  Hub_Idle04: 'idle_hub_04',
  Hub_Idle05: 'idle_hub_05',
  idle_01: 'idle_general_01',
  idle_20: 'idle_general_02',
  '001_motion_pose': 'idle_motion_pose_01',

  // --- locomotion ---
  RUN00_F: 'locomotion_run_f_01',
  RUN00_L: 'locomotion_run_l_01',
  RUN00_R: 'locomotion_run_r_01',
  run_00: 'locomotion_run_f_02',
  WALK00_F: 'locomotion_walk_f_01',
  WALK00_B: 'locomotion_walk_b_01',
  WALK00_L: 'locomotion_walk_l_01',
  WALK00_R: 'locomotion_walk_r_01',
  walk_00: 'locomotion_walk_f_02',
  SLIDE00: 'locomotion_slide_01',
  JUMP00: 'locomotion_jump_01',
  JUMP00B: 'locomotion_jump_02',
  JUMP01: 'locomotion_jump_03',
  JUMP01B: 'locomotion_jump_04',
  jump_10: 'locomotion_jump_05',
  jump_11: 'locomotion_jump_06',
  UMATOBI00: 'locomotion_vault_01',
  stroll: 'locomotion_stroll_01',

  // --- greet ---
  Wave: 'greet_wave_01',
  '004_hello_1': 'greet_hello_01',
  greet_00: 'greet_general_01',
  greet_02: 'greet_general_02',
  greet_03: 'greet_general_03',
  salute_00: 'greet_salute_01',
  shot_salute: 'greet_salute_02',
  emote_hey: 'greet_hey_01',

  // --- emote / reaction ---
  DAMAGED00: 'emote_damaged_01',
  DAMAGED01: 'emote_damaged_02',
  damage_25: 'emote_damaged_03',
  LOSE00: 'emote_lose_01',
  WIN00: 'emote_win_01',
  Hub_laugh01: 'emote_laugh_01',
  REFLESH00: 'emote_refresh_01',
  determined: 'emote_determined_01',
  elated: 'emote_elated_01',
  embar_01: 'emote_embarrassed_01',
  super_delicious: 'emote_delicious_01',
  we_ve_got_this: 'emote_confident_01',
  yay: 'emote_yay_01',
  lmao: 'emote_lmao_01',
  spot_awkward_smile: 'emote_awkward_smile_01',

  // --- pose (held / photo / gesture) ---
  '002_dogeza': 'pose_dogeza_01',
  '003_humidai': 'pose_humidai_01',
  '005_smartphone': 'pose_smartphone_01',
  '006_drinkwater': 'pose_drink_water_01',
  '007_gekirei': 'pose_gekirei_01',
  '008_gatan': 'pose_gatan_01',
  HANDUP00_R: 'pose_hand_up_01',
  pose_00: 'pose_general_01',
  pose_01: 'pose_general_02',
  finger_gun: 'pose_finger_gun_01',
  conduct_music: 'pose_conduct_music_01',
  shot_aori: 'pose_aori_01',
  shot_face_hand: 'pose_face_hand_01',
  shot_fight: 'pose_fight_01',
  shot_hair_up: 'pose_hair_up_01',
  shot_hizidon: 'pose_hizidon_01',
  shot_left_hand: 'pose_left_hand_01',
  shot_nicely_stand: 'pose_nice_stand_01',
  shot_nose: 'pose_nose_01',
  shot_question: 'pose_question_01',
  spot_target_locked: 'pose_target_locked_01',
  spot_hold_out_hands: 'pose_hold_out_hands_01',
  spot_look_over_shoulder: 'pose_look_over_shoulder_01',

  // --- combat ---
  kick_21: 'combat_kick_01',
  kick_23: 'combat_kick_02',
  kick_25: 'combat_kick_03',
  punch_21: 'combat_punch_01',
  special_20: 'combat_special_01',

  // --- acrobatic ---
  spot_acrobatic_1: 'acrobatic_general_01',
  spot_acrobatic_2: 'acrobatic_general_02',
  emote_front_tuck_flip: 'acrobatic_front_flip_01',

  // --- ground (crouch/lie/sit/stretch) ---
  spot_crouching_1: 'ground_crouch_01',
  spot_crouching_2: 'ground_crouch_02',
  spot_crouching_3: 'ground_crouch_03',
  spot_crouching_4: 'ground_crouch_04',
  spot_lie_down_1: 'ground_lie_01',
  spot_lie_down_2: 'ground_lie_02',
  spot_gazing_up_1: 'ground_gaze_up_01',
  spot_gazing_up_2: 'ground_gaze_up_02',
  shot_sitting: 'ground_sit_01',
  shot_standingKnee: 'ground_kneel_01',
  stretch: 'ground_stretch_01',

  // --- hand (static left-hand poses) ---
  L_Hand_Gao: 'hand_l_gao',
  L_Hand_Good: 'hand_l_good',
  L_Hand_Grip: 'hand_l_grip',
  L_Hand_Natural: 'hand_l_natural',
  L_Hand_Open: 'hand_l_open',
  L_Hand_Open_Index: 'hand_l_open_index',
  L_Hand_Open_V: 'hand_l_open_v',

  // --- costume change (gender variants) ---
  change_bottoms_m: 'costume_bottoms_m',
  change_bottoms_w: 'costume_bottoms_w',
  change_shoes_m: 'costume_shoes_m',
  change_shoes_w: 'costume_shoes_w',
  change_tops_m: 'costume_tops_m',
  change_tops_w: 'costume_tops_w',
  change_wait_m: 'costume_wait_m',
  change_wait_w: 'costume_wait_w',

  // --- home screen interaction ---
  home_idling_001_m: 'home_idle_m_01',
  home_idling_001_w: 'home_idle_w_01',
  home_intro_m: 'home_intro_m_01',
  home_intro_w: 'home_intro_w_01',
  home_tap_m: 'home_tap_m_01',
  home_tap_w: 'home_tap_w_01',

  // --- seasonal / event-specific ---
  shot_newyear_kirarajump_a: 'event_newyear_kirara_jump_01',
  shot_newyear_nezumi: 'event_newyear_nezumi_01',

  // --- generic library samples (verify in renderer & recategorize) ---
  VRMA_01: 'sample_vrma_01',
  VRMA_02: 'sample_vrma_02',
  VRMA_03: 'sample_vrma_03',
  VRMA_04: 'sample_vrma_04',
  VRMA_05: 'sample_vrma_05',
  VRMA_06: 'sample_vrma_06',
  VRMA_07: 'sample_vrma_07',
  'Take 001': 'sample_take_01',

  // --- defaults / neutral fixtures ---
  VRoid_F00_DefaultPose: 'default_pose_w',
  VRoid_M00_DefaultPose: 'default_pose_m',
  VRoid_UMA_APose: 'default_a_pose',
  VRoid_Arms: 'default_arms',
  VRoid_Shoes: 'default_shoes',
  // 'test-fixture' intentionally NOT renamed (generator skips it)
};

function rewriteId(absPath: string, newStem: string) {
  const raw = readFileSync(absPath, 'utf8');
  const obj = JSON.parse(raw) as { id?: string; [k: string]: unknown };
  if (obj.id !== newStem) {
    obj.id = newStem;
    writeFileSync(absPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }
}

let renamed = 0;
let skipped = 0;
const collisions: string[] = [];

for (const [oldStem, newStem] of Object.entries(RENAMES)) {
  const oldAbs = join(clipsDir, `${oldStem}.json`);
  const newAbs = join(clipsDir, `${newStem}.json`);
  if (!existsSync(oldAbs)) {
    console.warn(`[rename] missing source, skipping: ${oldStem}.json`);
    skipped++;
    continue;
  }
  if (existsSync(newAbs) && oldAbs !== newAbs) {
    collisions.push(`${oldStem} -> ${newStem} (target exists)`);
    continue;
  }
  if (oldAbs !== newAbs) {
    renameSync(oldAbs, newAbs);
  }
  rewriteId(newAbs, newStem);
  renamed++;
}

console.log(`[rename] renamed=${renamed} skipped=${skipped} collisions=${collisions.length}`);
if (collisions.length) {
  console.error('[rename] collisions:\n  ' + collisions.join('\n  '));
  process.exit(1);
}
