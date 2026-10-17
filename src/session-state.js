export const READ_STATE_KEY = 'dshContextLiteReadState';

export function createReadStateProjection(stateSchema) {
  const emptyReadState = Object.freeze({ turn: null, compactionGeneration: 0 });
  return {
    key: READ_STATE_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => emptyReadState,
    apply(state, event) {
      const nextTurn = Number.isInteger(event?.data?.turn) && event.data.turn >= 0
        ? event.data.turn
        : state.turn;
      const compacted = String(event?.type ?? '').startsWith('compaction/');
      if (nextTurn === state.turn && !compacted) return state;
      return {
        turn: nextTurn,
        compactionGeneration: state.compactionGeneration + (compacted ? 1 : 0),
      };
    },
  };
}
