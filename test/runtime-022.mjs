import {ToolExecutionPipeline} from '@deepseek-ai/dsh-tools/pipeline'
export async function dispatchTool(runtime,input){const pipeline=new ToolExecutionPipeline(input.agent?.ctx??runtime.ctx);const p=await pipeline.prepare(input);return pipeline.complete(p.exec,p.kind==='dispatch'?await pipeline.dispatch(p.exec):p)}
