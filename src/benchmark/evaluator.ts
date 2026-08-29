import type { LedgerAction } from '../domain/actions.js';
import {
  type LedgerDocument,
  type LedgerSnapshot,
  type ResolveContext,
  applyLedgerAction,
  assertLedgerInvariants,
  projectLedger,
} from '../domain/ledger.js';
import type { ActionInterpreter } from '../interpreters.js';
import type { BenchmarkScenario, BenchmarkTurn } from './scenarios.js';

export interface TurnEvaluation {
  turnId: string;
  expectedAction: LedgerAction;
  actualAction: LedgerAction;
  expectedSnapshot: LedgerSnapshot;
  actualSnapshot: LedgerSnapshot;
  expectMutation: boolean;
  mutationOccurred: boolean;
  clarificationOccurred: boolean;
}

export interface ScenarioEvaluation {
  scenarioId: string;
  turns: TurnEvaluation[];
  lsa: number;
  umr: number;
}

function snapshotsEqual(left: LedgerSnapshot, right: LedgerSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createContext(turnId: string, text: string): ResolveContext {
  return {
    now: new Date('2026-08-28T00:00:00.000Z'),
    turnId,
    sourceText: text,
    actor: 'system',
    idFactory: (() => {
      let index = 0;
      return () => `${turnId}-${String(++index).padStart(2, '0')}`;
    })(),
  };
}

export async function evaluateScenario(
  scenario: BenchmarkScenario,
  interpreter: ActionInterpreter,
): Promise<ScenarioEvaluation> {
  let document: LedgerDocument = {
    ...scenario.startingDocument,
    events: [...scenario.startingDocument.events],
  };

  const evaluations: TurnEvaluation[] = [];
  const recentTexts: string[] = [];

  for (const turn of scenario.turns) {
    const currentSnapshot = projectLedger(document);
    const actualAction =
      interpreter.kind === 'advanced'
        ? await interpreter.interpret({
            text: turn.inputText,
            language: turn.language,
            snapshot: currentSnapshot,
            recentTexts,
          })
        : await interpreter.interpret({
            text: turn.inputText,
            language: turn.language,
          });
    const context = createContext(turn.id, turn.inputText);
    const result = applyLedgerAction(document, actualAction, context);
    document = result.document;
    const actualSnapshot = projectLedger(document);
    assertLedgerInvariants(actualSnapshot);
    recentTexts.push(turn.inputText);

    evaluations.push({
      turnId: turn.id,
      expectedAction: turn.expectedAction,
      actualAction,
      expectedSnapshot: turn.expectedSnapshot,
      actualSnapshot,
      expectMutation: turn.expectMutation,
      mutationOccurred: result.financialMutation,
      clarificationOccurred: Boolean(result.clarification),
    });
  }

  const lsa =
    evaluations.length === 0
      ? 1
      : evaluations.filter(
          (evaluation) =>
            snapshotsEqual(evaluation.expectedSnapshot, evaluation.actualSnapshot) &&
            evaluation.expectedAction.type === evaluation.actualAction.type,
        ).length / evaluations.length;

  const unsafeMutationCount = evaluations.filter(
    (evaluation) => !evaluation.expectMutation && evaluation.mutationOccurred,
  ).length;

  return {
    scenarioId: scenario.id,
    turns: evaluations,
    lsa,
    umr: evaluations.length === 0 ? 0 : unsafeMutationCount / evaluations.length,
  };
}
