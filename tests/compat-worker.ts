import { Annotation, StateGraph, START, END, interrupt, Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
const saver = SqliteSaver.fromConnString(process.argv[2]);
const State = Annotation.Root({ answer: Annotation<string>() });
const graph = new StateGraph(State)
  .addNode('approval', () => ({ answer: interrupt({ reference: 'immutable-proposal-1' }) as string }))
  .addEdge(START, 'approval').addEdge('approval', END).compile({ checkpointer: saver });
const config = { configurable: { thread_id: 'compatibility-only' }, durability: 'sync' as const };
const result = await graph.invoke(process.argv[3] === 'resume' ? new Command({ resume: 'approved' }) : {}, config);
console.log(JSON.stringify({ result, snapshot: await graph.getState(config) }));
saver.db.close();
