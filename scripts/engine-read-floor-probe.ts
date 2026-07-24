/*
 * B66 Phase 1 Step 1 only.
 *
 * This is deliberately not a public API or a replacement read executor.  It
 * bundles the parser and the modules used by the current SELECT/WITH/UNION,
 * SHOW APPS, DESCRIBE, and EXPLAIN paths directly, without importing
 * src/execute.ts.  The result is an optimistic floor for a mechanically
 * extracted read router; orchestration currently embedded in execute.ts is not
 * represented here.
 */
import { parseSqlStatement } from "../src/core/sql";
import * as fieldSemantics from "../src/core/fieldSemantics";
import * as scalarCompare from "../src/core/scalarCompare";
import * as exactDecimal from "../src/core/exactDecimal";
import * as klikeValidation from "../src/core/klikeValidation";
import * as cteInlining from "../src/core/cteInlining";
import * as explainMetadata from "../src/core/explainMetadata";
import * as grouping from "../src/core/grouping";
import * as groupingValidation from "../src/core/groupingValidation";
import * as fetchAll from "../src/api/fetchAll";
import * as sharedPlanner from "../src/core/optimization/sharedPlanner";
import * as wherePredicatePushdown from "../src/core/optimization/wherePredicatePushdown";
import * as klikePushdownPlan from "../src/core/optimization/klikePushdownPlan";
import * as canonicalOrderPlanner from "../src/core/optimization/canonicalOrderPlanner";
import * as korderPlanner from "../src/core/optimization/korderPlanner";
import * as korderCursorExecutor from "../src/core/optimization/korderCursorExecutor";
import * as selectToKintone from "../src/converter/selectToKintone";
import * as whereToKintone from "../src/converter/whereToKintone";
import * as korderCursorQuery from "../src/converter/korderCursorQuery";
import * as like from "../src/core/like";
import * as process from "../src/engine/process";
import * as subtableAdapter from "../src/converter/subtableAdapter";
import * as evalWhere from "../src/engine/evalWhere";
import * as evalFunc from "../src/engine/evalFunc";

export const readFloorProbe = {
  parseSqlStatement,
  fieldSemantics,
  scalarCompare,
  exactDecimal,
  klikeValidation,
  cteInlining,
  explainMetadata,
  grouping,
  groupingValidation,
  fetchAll,
  sharedPlanner,
  wherePredicatePushdown,
  klikePushdownPlan,
  canonicalOrderPlanner,
  korderPlanner,
  korderCursorExecutor,
  selectToKintone,
  whereToKintone,
  korderCursorQuery,
  like,
  process,
  subtableAdapter,
  evalWhere,
  evalFunc,
};
