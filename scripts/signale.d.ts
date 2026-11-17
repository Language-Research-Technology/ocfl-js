// semantic-release's types import signale, which ships none
declare module 'signale' {
  export type Signale<Methods extends string> = Record<Methods, (...message: unknown[]) => void>;
}
