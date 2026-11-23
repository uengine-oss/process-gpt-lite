<script setup>
// 회사 프로세스 지도의 범례(왼쪽 아래, 누를 수 없음): 굵기 · 사람이 정한 것 · 은퇴 · 관찰 적음, 미리 보기(더함 · 뺌 · 바뀜),
// 의견(의견 N · 해소 필요). 색과 표시는 MapGraph.vue 와 같다. 바깥 틀은 .legend — 지도 화면의 좁은 화면 규칙(.narrow .legend)도 그대로 받는다.
defineProps({
  refined: Boolean, // 사람이 정했어요 · 정했지만 아직 본 적 없어요
  preview: Boolean, // 더함 · 뺌 · 바뀜
  notes: Boolean, // 의견 N · 해소 필요
})
</script>

<template>
  <div class="legend" data-testid="onto-map-legend">
    <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="3.5" /></svg>굵을수록 자주</span>
    <template v-if="refined">
      <span data-testid="onto-legend-decided">
        <svg width="15" height="12" viewBox="0 0 14 11" class="dec"><circle cx="3.6" cy="2.8" r="2.3" /><path d="M0.5,10.2 C0.5,7.1 2,5.7 3.6,5.7 C5.2,5.7 6.7,7.1 6.7,10.2" /><path d="M8,6.6 L9.8,8.5 L13,4.6" /></svg>사람이 정했어요
      </span>
      <span data-testid="onto-legend-unseen">
        <svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="2" stroke-dasharray="6 4" opacity=".55" /></svg><b class="word">정함</b>정했지만 아직 본 적 없어요
      </span>
    </template>
    <span><svg width="26" height="10"><path d="M1 5h24" stroke="#F0883E" stroke-width="2" stroke-dasharray="6 4" /></svg>은퇴 후보</span>
    <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="2" stroke-dasharray="2 4" opacity=".5" /></svg>은퇴함</span>
    <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="2" opacity=".35" /></svg>관찰 적음</span>
    <template v-if="preview">
      <span data-testid="onto-legend-add"><i class="box add" />더함</span>
      <span data-testid="onto-legend-remove"><i class="box rm"><s /></i>뺌</span>
      <span data-testid="onto-legend-change"><i class="box ch" />바뀜</span>
    </template>
    <template v-if="notes">
      <span data-testid="onto-legend-note"><b class="chip">의견 N</b>남은 의견</span>
      <span data-testid="onto-legend-conflict"><b class="chip conf">해소 필요</b>의견이 엇갈려요</span>
    </template>
  </div>
</template>

<style scoped>
.legend { --dec: #17979a; --conf: #e8590c; --d-add: #2f9e6e; --d-rm: var(--color-error); --d-ch: #c98a0c; }
.legend { position: absolute; left: 16px; bottom: 14px; right: 170px; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--text-secondary); pointer-events: none; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend svg { color: var(--text-secondary); flex: none; }
.dec circle, .dec path { fill: none; stroke: var(--dec); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.word { font-weight: 600; color: var(--dec); }
.box { position: relative; width: 18px; height: 12px; border-radius: 4px; box-sizing: border-box; flex: none; }
.box.add { border: 2px solid var(--d-add); background: color-mix(in srgb, var(--d-add) 14%, transparent); }
.box.rm { border: 1.5px dashed var(--d-rm); opacity: .8; }
.box.rm s { position: absolute; left: 2px; right: 2px; top: 50%; height: 1.5px; margin-top: -0.75px; background: var(--d-rm); }
.box.ch { border: 2px solid var(--d-ch); background: color-mix(in srgb, var(--d-ch) 14%, transparent); }
.chip { display: inline-flex; align-items: center; height: 16px; padding: 0 7px; border-radius: 8px; font-size: 10px; font-weight: 500; color: var(--text-secondary);
  background: var(--regular-solid-bg); border: 1px solid color-mix(in srgb, var(--text-primary) 22%, transparent); box-sizing: border-box; }
.chip.conf { background: var(--conf); border-color: transparent; color: #fff; font-weight: 700; }
</style>
