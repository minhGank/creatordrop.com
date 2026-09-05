export const calculateReelWinnerTranslation = (
  trackLeft: number,
  winnerLeft: number,
  winnerWidth: number,
): number => -(winnerLeft - trackLeft + winnerWidth / 2);
