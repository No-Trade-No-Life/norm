/**
 * 宿主模型：一条 ChatGPT 订阅（`openai-oauth`）里，替调用方发起工具调用的那条文本模型。
 *
 * 图像与搜索在订阅上都是同一个形状：上游没有专门的端点（没有 `/images/generations`，也没有
 * `/v1/web-search`），能力挂在一个工具上，得有一条文本模型替调用方说出那次工具调用。而同一个
 * 订阅里可达的型号各不相同——实测某个账户上 `gpt-5.4` 回 `model_not_found`，`gpt-6-luna`
 * 可用——所以它是一张候选表，不是一条常量。
 *
 * 宿主是谁与「调用方要的是哪件事」无关：它属于订阅，属于这条上游，不属于那次调用。所以两张
 * 能力的候选表是同一张，调用方两端都看不见它。
 */
export const HOST_MODELS = ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-sol'] as const;

/** 上游说「这个宿主模型不认」时能试几次（每条候选一次上游请求，别变成一次扫荡）。 */
export const MAX_HOST_ATTEMPTS = 2;
