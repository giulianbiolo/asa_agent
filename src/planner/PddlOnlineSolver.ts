import fetch, { Response } from "node-fetch";
import { spawn, exec } from "child_process";
import { sleep } from "bun";
import { agentArgs } from "../args";
import type { pddlPlanStep } from "@unitn-asa/pddl-client/src/PddlOnlineSolver";
import { client, local_planner_mutex } from "../agent";
import fs from "fs";
import clc from "chalk";
import { MsgBuilder, MsgType } from "../communication";


const BASE_URL: string = agentArgs.pddlSolverURL;
const FETCH_URL: string = BASE_URL + "/package/lama-first/solve";

/**
 * Validate inputs to ensure they are strings.
 * @param {String} pddlDomain
 * @param {String} pddlProblem
 * @throws Will throw an error if inputs are not strings.
 */
function validateInputs(pddlDomain: any, pddlProblem: any): void {
  if (typeof pddlDomain !== "string" && !(pddlDomain instanceof String)) {
    throw new Error("pddlDomain is not a string");
  }
  if (typeof pddlProblem !== "string" && !(pddlProblem instanceof String)) {
    throw new Error("pddlProblem is not a string");
  }
}

/**
 * 
 * @param {string} resource the URL to fetch
 * @param {any} options the options for the fetch request
 * @returns the response from the fetch request
 */
async function fetchWithTimeout(resource: string, options: any = {}): Promise<Response> {
  const { timeout = 8000 } = options; // ? Default timeout is 8 seconds
  const controller: AbortController = new AbortController();
  const id: Timer = setTimeout(() => controller.abort(), timeout);
  const response: Response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
}


/**
 * Get the URL to fetch the plan
 * @param {String} pddlDomain
 * @param {String} pddlProblem
 * @returns {Promise<Object>}
 * @throws Will throw an error if the fetch fails.
 */
async function getPlanFetchUrl(
  pddlDomain: string,
  pddlProblem: string
): Promise<any> {
  try {
    const response = await fetchWithTimeout(FETCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        domain: pddlDomain,
        problem: pddlProblem,
        number_of_plans: 1,
      }),
    });
    if (!response.ok) {
      throw new Error(`Error at ${FETCH_URL}: ${response.statusText}`);
    }
    const result: any = await response.json();
    if (result.status === "error") {
      const errorMessage: string = result.result.error || "Unknown error";
      throw new Error(`Error at ${FETCH_URL}: ${errorMessage}`);
    }
    return result.result;
  } catch (error: any) {
    console.log(`Failed to fetch initial plan: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch the plan until it's ready or times out.
 * @param {String} fetchPlanUrl
 * @param {number} maxAttempts - Maximum number of retry attempts
 * @param {number} baseDelay - Base delay in milliseconds for exponential backoff
 * @returns {Promise<Object>}
 * @throws Will throw an error if the fetch fails or times out.
 */
async function fetchPlan(
  fetchPlanUrl: string,
  maxAttempts: number = 10,
  baseDelay: number = 100
): Promise<any> {
  let attempts: number = 0;
  let response: any = null;

  const fetchWithRetry = async () => {
    const fetchResponse = await fetchWithTimeout(fetchPlanUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      // body: JSON.stringify({ adaptor: "planning_editor_adaptor" }),
    });

    if (!fetchResponse.ok) {
      throw new Error(`Error at ${fetchPlanUrl}: ${fetchResponse.statusText}`);
    }
    response = await fetchResponse.json();
    if (response.status === "error") {
      const errorMessage: string = response.result.error || "Unknown error";
      throw new Error(`Error at ${fetchPlanUrl}: ${errorMessage}`);
    }
    return response;
  };

  while (attempts < maxAttempts) {
    attempts++;
    await sleep(baseDelay);
    try {
      response = await fetchWithRetry();
      if (response.status !== "PENDING") {
        return response.result.output.sas_plan;
      }
    } catch (error: any) {
      console.log(`Attempt ${attempts} failed: ${error.message}`);
      if (attempts === maxAttempts) {
        throw new Error("Timeout while waiting for the detailed plan");
      }
    }
  }
  throw new Error("Failed to fetch detailed plan after maximum attempts");
}

/**
 * Process the plan result into pddlPlanStep array.
 * @param {Object} planResult
 * @returns {PddlPlanStep[]}
 */
function processPlan(planResult: string): pddlPlanStep[] {
  let lines: Array<string> = planResult.split("\n");
  let liness: Array<Array<string>> = lines.map((line: string) => line.replace("(", "").replace(")", "").split(" "));
  liness = liness.filter((line: Array<string>) => line.length > 2 && line[0] !== ";");

  var plan: Array<pddlPlanStep> = [];

  for (let line of liness) {
    let action = line.shift();
    let args = line; // ? [move, agent, p1, p0]
    if (action !== undefined) { plan.push({ parallel: false, action: action, args: args }); }
  }
  return plan;
}

/**
 * @param {String} pddlDomain
 * @param {String} pddlProblem
 * @returns {Promise<PddlPlanStep[]>}
 */
export default async function onlineSolver(
  pddlDomain: string,
  pddlProblem: string
): Promise<pddlPlanStep[]> {
  try {
    validateInputs(pddlDomain, pddlProblem);
    const fetchPlanUrlRes: string = await getPlanFetchUrl(
      pddlDomain,
      pddlProblem
    );
    if (!fetchPlanUrlRes) {
      return [];
    }
    const fetchPlanUrl: string = BASE_URL + fetchPlanUrlRes;
    const detailedPlan: any = await fetchPlan(fetchPlanUrl);
    if (!detailedPlan) {
      return [];
    }
    return processPlan(detailedPlan);
  } catch (error: any) {
    console.log(`Error in onlineSolver: ${error.message}`);
    return [];
  }
}


/**
 * @param {String} pddlDomain
 * @param {String} pddlProblem
 * @returns {Promise<PddlPlanStep[]>}
 */
export async function offlineSolver(
  pddlDomain: string,
  pddlProblem: string
): Promise<pddlPlanStep[]> {
  try {
    validateInputs(pddlDomain, pddlProblem);
  } catch (error: any) {
    console.log(`Error in offlineSolver: ${error.message}`);
    return [];
  }
  // ? Save both domain and problem to files
  while (local_planner_mutex) { await sleep(100); }
  let msg: MsgBuilder = new MsgBuilder().kind(MsgType.ON_LOCAL_PLANNER).local_planner(true);
  if (msg.valid()) { client.say(agentArgs.teamId, msg.build()); }
  try {
    const pddlDomainBuf = Buffer.alloc(Buffer.byteLength(pddlDomain, 'utf8'), pddlDomain, 'utf8');
    const pddlProblemBuf = Buffer.alloc(Buffer.byteLength(pddlProblem, 'utf8'), pddlProblem, 'utf8');
    fs.writeFileSync("/tmp/domain.pddl", pddlDomainBuf);
    fs.writeFileSync("/tmp/problem.pddl", pddlProblemBuf);
    console.log("Saved domain and problem to files");

    // ? Run the planner
    // ? Execute /opt/fast-downward/fast-downward.py --alias lama-first domain.pddl problem.pddl
    let child = spawn(
      "python",
      ["/opt/fast-downward/fast-downward.py", "/tmp/domain.pddl", "/tmp/problem.pddl", "--evaluator", '"hcea=cea()"', "--search", '"lazy_greedy([hcea], preferred=[hcea])"'],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      }
    );
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    let timeout = 3000;
    let start = Date.now();
    while (child.exitCode === null && Date.now() - start < timeout) { await sleep(100); }
    if (child.pid !== undefined) { try { process.kill(child.pid); } catch (err: any) { console.log("error killing child process: ", err); } }
    // ? Read the plan from the plan file
    const detailedPlan = fs.readFileSync("./sas_plan").toString();
    console.log(clc.bgGreenBright("Plan: "), detailedPlan);
    if (!detailedPlan) {
      return [];
    }
    return processPlan(detailedPlan);
  } catch (error: any) {
    console.log(`Error in offlineSolver: ${error.message}`);
    return [];
  } finally {
    let msg: MsgBuilder = new MsgBuilder().kind(MsgType.ON_LOCAL_PLANNER).local_planner(false);
    if (msg.valid()) { client.say(agentArgs.teamId, msg.build()); }
  }
}
