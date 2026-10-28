/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as accessPolicy from "../accessPolicy.js";
import type * as areas from "../areas.js";
import type * as courses from "../courses.js";
import type * as crons from "../crons.js";
import type * as labs from "../labs.js";
import type * as observability from "../observability.js";
import type * as progress from "../progress.js";
import type * as runners from "../runners.js";
import type * as scenarioArtifactPolicy from "../scenarioArtifactPolicy.js";
import type * as scenarioArtifacts from "../scenarioArtifacts.js";
import type * as scenarioSeedData from "../scenarioSeedData.js";
import type * as scenarioSessionPolicy from "../scenarioSessionPolicy.js";
import type * as sessionLifecycle from "../sessionLifecycle.js";
import type * as sessions from "../sessions.js";
import type * as sha256 from "../sha256.js";
import type * as stepPolicy from "../stepPolicy.js";
import type * as steps from "../steps.js";
import type * as users from "../users.js";
import type * as workspaceAccess from "../workspaceAccess.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accessPolicy: typeof accessPolicy;
  areas: typeof areas;
  courses: typeof courses;
  crons: typeof crons;
  labs: typeof labs;
  observability: typeof observability;
  progress: typeof progress;
  runners: typeof runners;
  scenarioArtifactPolicy: typeof scenarioArtifactPolicy;
  scenarioArtifacts: typeof scenarioArtifacts;
  scenarioSeedData: typeof scenarioSeedData;
  scenarioSessionPolicy: typeof scenarioSessionPolicy;
  sessionLifecycle: typeof sessionLifecycle;
  sessions: typeof sessions;
  sha256: typeof sha256;
  stepPolicy: typeof stepPolicy;
  steps: typeof steps;
  users: typeof users;
  workspaceAccess: typeof workspaceAccess;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
