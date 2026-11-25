"""LangGraph capabilities behind FastAPI.

Two-node stateless graph, checkpointed threads, human-in-the-loop interrupt and
resume, checkpoint history (time travel), a parent graph with a subgraph node,
and one SSE stream. Each capability has its own route so the bridge contract can
carry it and a generated client can exercise it.
"""

import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
import operator
import os
import sqlite3
from importlib.metadata import version
from typing import Annotated, TypedDict

import requests
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, Send, interrupt
from pydantic import BaseModel, Field

print(f"[service] langgraph={version('langgraph')} langchain_core={version('langchain-core')}", flush=True)

app = FastAPI(title="langgraph-capabilities")

# A run parked on a human gate keeps its worker thread busy until it is resumed, which can be
# minutes or longer. Giving orchestration its own pool keeps those threads from starving the
# default executor that other blocking calls share.
_ORCHESTRATOR_POOL = ThreadPoolExecutor(
    max_workers=int(os.environ.get("BRIDGE_ORCHESTRATOR_WORKERS", "8")),
    thread_name_prefix="orchestrator",
)


def _build_checkpointer():
    """Persistent checkpoints: a paused graph must survive a service restart.

    Falls back to memory only when the sqlite saver cannot be opened, so a broken data
    directory degrades visibly in the log instead of failing startup.
    """
    data_dir = os.environ.get("BRIDGE_DATA_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "data")
    try:
        os.makedirs(data_dir, exist_ok=True)
        from langgraph.checkpoint.sqlite import SqliteSaver
        path = os.path.join(data_dir, "checkpoints.sqlite3")
        connection = sqlite3.connect(path, check_same_thread=False)
        saver = SqliteSaver(connection)
        try:
            saver.setup()
        except Exception:
            pass
        print(f"[service] checkpointer=sqlite path={path}", flush=True)
        return saver
    except Exception as exc:
        from langgraph.checkpoint.memory import InMemorySaver
        print(f"[service] checkpointer=memory ({exc})", flush=True)
        return InMemorySaver()


memory = _build_checkpointer()


# --- stateless two-node graph ------------------------------------------------
class GraphState(TypedDict):
    value: int
    steps: list[str]


def _add_one(state: GraphState) -> dict:
    return {"value": state["value"] + 1, "steps": state["steps"] + ["add_one"]}


def _double(state: GraphState) -> dict:
    return {"value": state["value"] * 2, "steps": state["steps"] + ["double"]}


_builder = StateGraph(GraphState)
_builder.add_node("add_one", _add_one)
_builder.add_node("double", _double)
_builder.add_edge(START, "add_one")
_builder.add_edge("add_one", "double")
_builder.add_edge("double", END)
simple_graph = _builder.compile()


# --- checkpointed thread graph ----------------------------------------------
counter_builder = StateGraph(GraphState)
counter_builder.add_node("add_one", _add_one)
counter_builder.add_node("double", _double)
counter_builder.add_edge(START, "add_one")
counter_builder.add_edge("add_one", "double")
counter_builder.add_edge("double", END)
thread_graph = counter_builder.compile(checkpointer=memory)


# --- interrupt / resume graph ------------------------------------------------
class ReviewState(TypedDict):
    value: int
    answer: str | None
    status: str


def _bump(state: ReviewState) -> dict:
    return {"value": state["value"] + 1, "status": "awaiting_review"}


def _ask(state: ReviewState) -> dict:
    reply = interrupt({"question": "approve the draft?", "value": state["value"]})
    return {"answer": str(reply), "status": "done"}


review_builder = StateGraph(ReviewState)
review_builder.add_node("bump", _bump)
review_builder.add_node("ask", _ask)
review_builder.add_edge(START, "bump")
review_builder.add_edge("bump", "ask")
review_builder.add_edge("ask", END)
review_graph = review_builder.compile(checkpointer=memory)


# --- subgraph ----------------------------------------------------------------
class ChildState(TypedDict):
    value: int
    steps: list[str]


def _child_step(state: ChildState) -> dict:
    return {"value": state["value"] + 10, "steps": state["steps"] + ["child"]}


child_builder = StateGraph(ChildState)
child_builder.add_node("child", _child_step)
child_builder.add_edge(START, "child")
child_builder.add_edge("child", END)
child_graph = child_builder.compile()


class SubgraphState(TypedDict):
    value: int
    steps: list[str]


def _parent_first(state: SubgraphState) -> dict:
    return {"value": state["value"] * 2, "steps": state["steps"] + ["parent_first"]}


def _call_child(state: SubgraphState) -> dict:
    result = child_graph.invoke({"value": state["value"], "steps": state["steps"]})
    return {"value": result["value"], "steps": result["steps"]}


sub_builder = StateGraph(SubgraphState)
sub_builder.add_node("parent_first", _parent_first)
sub_builder.add_node("call_child", _call_child)
sub_builder.add_edge(START, "parent_first")
sub_builder.add_edge("parent_first", "call_child")
sub_builder.add_edge("call_child", END)
subgraph = sub_builder.compile()


# --- models ------------------------------------------------------------------
class RunRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000)
    thread_id: str | None = None


class RunResponse(BaseModel):
    value: int
    steps: list[str]


class ThreadRunRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000)


class ThreadRunResponse(BaseModel):
    value: int
    steps: list[str]
    checkpoint_id: str | None


class StateResponse(BaseModel):
    value: int
    steps: list[str]
    next_nodes: list[str]
    checkpoint_id: str | None


class ReviewStartRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000)


class ReviewStartResponse(BaseModel):
    status: str
    prompt: str | None
    checkpoint_id: str | None


class ReviewResumeRequest(BaseModel):
    answer: str


class ReviewResumeResponse(BaseModel):
    status: str
    answer: str | None
    value: int | None


class CheckpointEntry(BaseModel):
    step: int
    checkpoint_id: str
    value: int | None
    next_nodes: list[str]


class HistoryResponse(BaseModel):
    entries: list[CheckpointEntry]


class ReplayRequest(BaseModel):
    checkpoint_id: str


class SubgraphRequest(BaseModel):
    value: int = Field(..., ge=0, le=1000)


class SubgraphResponse(BaseModel):
    value: int
    steps: list[str]


class HealthResponse(BaseModel):
    status: str


class OrchestrateRequest(BaseModel):
    run_id: str
    worker_base: str = Field(..., description="Java worker root, e.g. http://host.docker.internal:18091")


class OrchestrateResponse(BaseModel):
    run_id: str
    route: str | None
    steps: list[str]


class OrchestrateResumeRequest(BaseModel):
    run_id: str
    worker_base: str = Field(..., description="Java worker root, e.g. http://host.docker.internal:18091")
    value: dict | None = Field(None, description="Submitted human decision, replayed into the interrupted node")


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def _checkpoint_id(snapshot) -> str | None:
    if snapshot is None:
        return None
    return (snapshot.config.get("configurable") or {}).get("checkpoint_id")


# --- routes ------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Report service health."""
    return HealthResponse(status="ok")


@app.post("/runs", response_model=RunResponse, status_code=201)
async def run_graph(payload: RunRequest) -> RunResponse:
    """Run the stateless two-node graph for one value."""
    result = simple_graph.invoke({"value": payload.value, "steps": []})
    return RunResponse(value=result["value"], steps=result["steps"])


@app.post("/threads/{thread_id}/runs", response_model=ThreadRunResponse, status_code=201)
async def run_thread(thread_id: str, payload: ThreadRunRequest) -> ThreadRunResponse:
    """Run the graph for a thread and persist a checkpoint."""
    result = thread_graph.invoke({"value": payload.value, "steps": []}, _config(thread_id))
    snapshot = thread_graph.get_state(_config(thread_id))
    return ThreadRunResponse(value=result["value"], steps=result["steps"], checkpoint_id=_checkpoint_id(snapshot))


@app.get("/threads/{thread_id}/state", response_model=StateResponse)
async def thread_state(thread_id: str) -> StateResponse:
    """Read the latest persisted state of a thread."""
    snapshot = thread_graph.get_state(_config(thread_id))
    values = snapshot.values or {}
    return StateResponse(
        value=int(values.get("value", 0)),
        steps=list(values.get("steps", [])),
        next_nodes=list(snapshot.next or ()),
        checkpoint_id=_checkpoint_id(snapshot),
    )


@app.post("/threads/{thread_id}/review", response_model=ReviewStartResponse, status_code=201)
async def start_review(thread_id: str, payload: ReviewStartRequest) -> ReviewStartResponse:
    """Start the review graph; it stops at the interrupt and waits for a resume."""
    review_graph.invoke({"value": payload.value, "answer": None, "status": "started"}, _config(thread_id))
    snapshot = review_graph.get_state(_config(thread_id))
    prompt = None
    for task in snapshot.tasks or ():
        for item in getattr(task, "interrupts", ()) or ():
            prompt = json.dumps(item.value, default=str)
    pending = bool(snapshot.next)
    return ReviewStartResponse(
        status="interrupted" if pending else "done",
        prompt=prompt,
        checkpoint_id=_checkpoint_id(snapshot),
    )


@app.post("/threads/{thread_id}/review/resume", response_model=ReviewResumeResponse)
async def resume_review(thread_id: str, payload: ReviewResumeRequest) -> ReviewResumeResponse:
    """Resume an interrupted graph with the reviewer's answer."""
    result = review_graph.invoke(Command(resume=payload.answer), _config(thread_id))
    return ReviewResumeResponse(
        status=str(result.get("status", "done")),
        answer=None if result.get("answer") is None else str(result["answer"]),
        value=None if result.get("value") is None else int(result["value"]),
    )


@app.get("/threads/{thread_id}/history", response_model=HistoryResponse)
async def thread_history(thread_id: str) -> HistoryResponse:
    """List every checkpoint of a thread, newest first."""
    entries = []
    for snapshot in thread_graph.get_state_history(_config(thread_id)):
        values = snapshot.values or {}
        entries.append(CheckpointEntry(
            step=int(snapshot.metadata.get("step", 0)) if snapshot.metadata else 0,
            checkpoint_id=_checkpoint_id(snapshot) or "",
            value=None if values.get("value") is None else int(values["value"]),
            next_nodes=list(snapshot.next or ()),
        ))
    return HistoryResponse(entries=entries)


@app.post("/threads/{thread_id}/replay", response_model=StateResponse)
async def replay(thread_id: str, payload: ReplayRequest) -> StateResponse:
    """Read the state recorded at one past checkpoint."""
    config = {"configurable": {"thread_id": thread_id, "checkpoint_id": payload.checkpoint_id}}
    snapshot = thread_graph.get_state(config)
    values = snapshot.values or {}
    return StateResponse(
        value=int(values.get("value", 0)),
        steps=list(values.get("steps", [])),
        next_nodes=list(snapshot.next or ()),
        checkpoint_id=_checkpoint_id(snapshot),
    )


@app.post("/subgraph/run", response_model=SubgraphResponse)
async def run_subgraph(payload: SubgraphRequest) -> SubgraphResponse:
    """Run a parent graph that invokes a compiled child graph as one node."""
    result = subgraph.invoke({"value": payload.value, "steps": []})
    return SubgraphResponse(value=result["value"], steps=result["steps"])


@app.get("/threads/{thread_id}/stream")
async def stream_thread(thread_id: str) -> StreamingResponse:
    """Stream graph updates as server-sent events."""

    async def events():
        async for chunk in simple_graph.astream({"value": 1, "steps": []}, stream_mode="updates"):
            yield f"data: {json.dumps(chunk, default=str)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


# --- callback-worker orchestration -------------------------------------------
# Topology comes from the Java worker's descriptor, so node names are declared once.
# Each node's work stays in Java: one node = one callback.
class OrchestrateState(TypedDict, total=False):
    route: str | None
    failures: int
    steps: Annotated[list[str], operator.add]


def _call_worker(worker_base: str, run_id: str, node: str, resume: dict | None = None) -> dict:
    url = f"{worker_base.rstrip('/')}/internal/graph/{run_id}/nodes/{node}"
    body = {} if resume is None else {"resume": resume}
    try:
        # A paused run blocks this callback until it is resumed, so the read timeout is long.
        response = requests.post(url, json=body, timeout=(10, 1800))
        response.raise_for_status()
        result = response.json()
    except Exception as exc:
        # One line per callback, carrying the same run id the Java log uses, so a failure can
        # be followed across both languages.
        print(f"[orchestrator] run={run_id} node={node} ERROR {type(exc).__name__}: {exc}", flush=True)
        raise
    route = result.get("route")
    interrupted = " INTERRUPTED" if result.get("interrupted") else ""
    print(f"[orchestrator] run={run_id} node={node} route={route} failures={result.get('failures', 0)}{interrupted}",
          flush=True)
    return result


def _descriptor(worker_base: str) -> dict:
    response = requests.get(f"{worker_base.rstrip('/')}/internal/graph/descriptor", timeout=30)
    response.raise_for_status()
    return response.json()


def _build_orchestrator(run_id: str, worker_base: str):
    descriptor = _descriptor(worker_base)
    sections = list(descriptor.get("sections", []))
    analysis = list(descriptor.get("analysis", []))
    recommendation = list(descriptor.get("recommendation", []))

    def step_node(name: str):
        """A node whose route the orchestrator needs (admission, joins, gate, ...)."""

        def run(state: OrchestrateState) -> dict:
            result = _call_worker(worker_base, run_id, name)
            if result.get("paused"):
                # The worker asked to park instead of holding a thread; the graph stops here
                # and this node is replayed after the resume.
                interrupt({"paused": True, "stage": result.get("stage")})
                result = _call_worker(worker_base, run_id, name)
            if result.get("interrupted"):
                # Pause the graph natively; the submitted value is replayed into the node.
                submitted = interrupt({"prompt": result.get("prompt")})
                result = _call_worker(worker_base, run_id, name, resume={"0": submitted})
            return {
                "route": result.get("route") or state.get("route"),
                "failures": int(result.get("failures") or 0),
                "steps": [name],
            }

        return run

    def section_node(name: str):
        """A fanned-out section: only progress is reported back to the graph."""

        def run(state: OrchestrateState) -> dict:
            result = _call_worker(worker_base, run_id, name)
            if result.get("paused"):
                interrupt({"paused": True, "stage": result.get("stage")})
                _call_worker(worker_base, run_id, name)
            return {"steps": [name]}

        return run

    def fan_out(targets: list[str]):
        return [Send(target, {"steps": []}) for target in targets]

    builder = StateGraph(OrchestrateState)
    builder.add_node("admission", step_node("admission"))
    builder.add_node("freeze", step_node("freeze"))
    builder.add_node("materials", step_node("materials"))
    for name in sections:
        builder.add_node(name, section_node(name))
    builder.add_node("analysis_join", step_node("analysis_join"))
    builder.add_node("final_join", step_node("final_join"))
    builder.add_node("gate", step_node("gate"))
    builder.add_node("aggregate", step_node("aggregate"))

    builder.add_edge(START, "admission")
    builder.add_conditional_edges(
        "admission", lambda state: "freeze" if state.get("route") == "allowed" else END, ["freeze", END])
    builder.add_edge("freeze", "materials")
    builder.add_conditional_edges(
        "materials",
        lambda state: fan_out(analysis) if not state.get("failures") else END,
        [*analysis, END],
    )
    for name in analysis:
        builder.add_edge(name, "analysis_join")
    builder.add_conditional_edges(
        "analysis_join",
        lambda state: fan_out(recommendation) if not state.get("failures") else END,
        [*recommendation, END],
    )
    for name in recommendation:
        builder.add_edge(name, "final_join")
    builder.add_conditional_edges(
        "final_join", lambda state: "gate" if not state.get("failures") else END, ["gate", END])
    builder.add_conditional_edges(
        "gate", lambda state: "aggregate" if state.get("route") == "approved" else END, ["aggregate", END])
    builder.add_edge("aggregate", END)
    return builder.compile(checkpointer=memory)


@app.post("/orchestrate/preflight", response_model=OrchestrateResponse)
async def orchestrate_preflight(payload: OrchestrateRequest) -> OrchestrateResponse:
    """Run the workflow graph natively, calling back into the Java worker per node."""
    graph = _build_orchestrator(payload.run_id, payload.worker_base)
    config = {"configurable": {"thread_id": f"preflight:{payload.run_id}"}}
    # The graph calls back into the worker with blocking HTTP for every node, and a paused
    # run can sit there for a long time. Running it off the event loop keeps /health and every
    # other endpoint responsive while a workflow is in flight.
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        _ORCHESTRATOR_POOL,
        graph.invoke, {"route": None, "failures": 0, "steps": []}, config)
    return OrchestrateResponse(
        run_id=payload.run_id,
        route=result.get("route"),
        steps=list(result.get("steps", [])),
    )


@app.post("/orchestrate/resume", response_model=OrchestrateResponse)
async def orchestrate_resume(payload: OrchestrateResumeRequest) -> OrchestrateResponse:
    """Resume a graph parked on interrupt(), replaying the submitted value into its node.

    <p>The paused graph lives in the checkpointer under the run's thread id, so the
    orchestrator is rebuilt from the same descriptor and continues from that checkpoint.
    """
    graph = _build_orchestrator(payload.run_id, payload.worker_base)
    config = {"configurable": {"thread_id": f"preflight:{payload.run_id}"}}
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        _ORCHESTRATOR_POOL, graph.invoke, Command(resume=payload.value), config)
    return OrchestrateResponse(
        run_id=payload.run_id,
        route=result.get("route"),
        steps=list(result.get("steps", [])),
    )
