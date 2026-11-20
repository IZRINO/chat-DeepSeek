import { isTranslationKey, translate, type TranslationKey } from '../../i18n/index.js'
import { transportLabels, type MessageDiagnostic, type MessageStage } from '../api/diagnostics.js'
import { classifyStatus } from '../api/errors.js'
import type { AssistantMessage } from './types.js'

export type Notice = {
  text: string
  details?: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /** 需要用户处理的问题附带的操作 */
  action?: 'apiKey' | 'topUp'
}

const getTemplateText = (reply: AssistantMessage) =>
  reply.blocks
    .map((block) => (block.type === 'text' && block.isTemplate ? block.text : ''))
    .join('')

const stages: Record<MessageStage, TranslationKey> = {
  chat: 'requestStageChat',
  search: 'requestStageSearch',
  readLink: 'requestStageReadLink',
}

const describeRequestError = (
  { kind, status }: NonNullable<AssistantMessage['error']>,
  diagnostic: MessageDiagnostic
): Notice => {
  const { stage, endpoint, transport, reason, serviceMessage, requestId } = diagnostic
  let explanation: string
  let action: Notice['action']
  switch (classifyStatus(status)) {
    case 'unauthorized':
      explanation = translate(stage === 'chat' ? 'replyInvalidApiKey' : 'requestCheckSearchKey')
      action = 'apiKey'
      break
    case 'insufficientBalance':
      explanation = translate('replyInsufficientBalance')
      if (stage !== 'chat' || endpoint.startsWith('https://api.deepseek.com/')) {
        action = 'topUp'
      }
      break
    case 'rateLimited':
      explanation = translate('replyRateLimited')
      break
    case 'serverBusy':
      explanation = translate('completionServerBusyToast')
      break
    default:
      explanation =
        kind === 'network'
          ? translate('requestNoResponse')
          : kind === 'http' && status
            ? translate('requestHttpError', { status })
            : kind === 'interrupted'
              ? translate('requestInterrupted')
              : kind === 'stream'
                ? translate('requestStreamError')
                : translate(stage === 'chat' ? 'requestInvalidResponse' : 'requestInvalidWebData')
  }
  return {
    text: translate('requestStageFailure', {
      stage: translate(stages[stage]),
      reason: explanation,
    }),
    details: [
      `POST ${endpoint}`,
      [transportLabels[transport], status !== undefined ? `HTTP ${status}` : '', reason]
        .filter(Boolean)
        .join(' · '),
      serviceMessage,
      requestId && translate('requestIdLabel', { id: requestId }),
    ]
      .filter(Boolean)
      .join('\n'),
    action,
  }
}

/** 回复出错或未正常结束时展示的提示 */
export const describeReply = (reply: AssistantMessage): Notice | null => {
  if (reply.status === 'error' && reply.error) {
    if (reply.error.diagnostic) {
      return describeRequestError(reply.error, reply.error.diagnostic)
    }
    const { kind, status, localMessage } = reply.error
    // 导入的历史可能来自不同版本；不识别的文案沿用保存时的原文。
    const message =
      localMessage && isTranslationKey(localMessage.key)
        ? translate(localMessage.key, localMessage.params)
        : reply.error.message
    // 历史补传错误刷新后仍需说明原因，恢复沿用附件卡片或重新生成。
    if (kind === 'upload') {
      return { text: message || translate('uploadFileStatusFailed') }
    }
    if (kind === 'network') {
      return { text: translate('commonNetworkErrorToast') }
    }
    switch (classifyStatus(status)) {
      case 'unauthorized':
        return { text: translate('replyInvalidApiKey'), action: 'apiKey' }
      case 'insufficientBalance':
        return { text: translate('replyInsufficientBalance'), action: 'topUp' }
      case 'rateLimited':
        return { text: translate('replyRateLimited') }
      case 'serverBusy':
        return { text: translate('completionServerBusyToast') }
      default:
        return message ? { text: message } : null
    }
  }
  const template = getTemplateText(reply)
  // 归档不带结构化错误，错误文案保存在模板中，仍按错误提示展示。
  if (reply.status === 'error' && template) {
    return { text: template }
  }
  if (reply.stopReason === 'refusal') {
    // 导入的拒绝回复优先展示归档中的模板，普通正文仍不可展示。
    return { text: template || translate('replyRefused'), presentation: 'response' }
  }
  if (template) {
    return { text: template, presentation: 'response' }
  }
  return null
}
