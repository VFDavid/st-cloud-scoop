import axios from 'axios'
import { supabaseAdmin } from './supabase'

export class SlackNotificationService {
  private webhookUrl: string

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || ''
  }

  private async isNotificationEnabled(notificationType: string): Promise<boolean> {
    try {
      const { data: setting } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', `slack_${notificationType}_enabled`)
        .single()

      return setting?.value === 'true'
    } catch (error) {
      // Default to enabled if setting doesn't exist
      return true
    }
  }

  private async getWebhookUrl(): Promise<string> {
    try {
      const { data: setting } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', 'slack_webhook_url')
        .single()

      return setting?.value || this.webhookUrl
    } catch (error) {
      return this.webhookUrl
    }
  }

  async sendSimpleMessage(message: string) {
    if (!this.webhookUrl) {
      console.warn('Slack webhook URL not configured')
      return
    }

    try {
      const payload = {
        text: message
      }

      await axios.post(this.webhookUrl, payload)

      // Log the notification
      await supabaseAdmin
        .from('system_logs')
        .insert([{
          level: 'info',
          message: 'Simple Slack message sent',
          context: { message },
          source: 'slack_service'
        }])

    } catch (error) {
      console.error('Failed to send simple Slack message:', error)

      // Log the failure
      await supabaseAdmin
        .from('system_logs')
        .insert([{
          level: 'error',
          message: 'Failed to send simple Slack message',
          context: {
            message,
            error: error instanceof Error ? error.message : 'Unknown error'
          },
          source: 'slack_service'
        }])
    }
  }

  async sendAlert(message: string, level: 'info' | 'warn' | 'error' = 'info', notificationType?: string) {
    const webhookUrl = await this.getWebhookUrl()
    if (!webhookUrl) {
      console.warn('Slack webhook URL not configured')
      return
    }

    // Check if this notification type is enabled
    if (notificationType && !(await this.isNotificationEnabled(notificationType))) {
      console.log(`Slack notification skipped - ${notificationType} is disabled`)
      return
    }

    try {
      const emoji = {
        info: ':information_source:',
        warn: ':warning:',
        error: ':rotating_light:'
      }[level]

      const payload = {
        text: `${emoji} ${message}`
      }

      await axios.post(webhookUrl, payload)

      // Log the notification
      await supabaseAdmin
        .from('system_logs')
        .insert([{
          level: 'info',
          message: 'Slack notification sent',
          context: { originalMessage: message, level, context },
          source: 'slack_service'
        }])

    } catch (error) {
      console.error('Failed to send Slack notification:', error)

      // Log the failure
      await supabaseAdmin
        .from('system_logs')
        .insert([{
          level: 'error',
          message: 'Failed to send Slack notification',
          context: {
            originalMessage: message,
            level,
            context,
            error: error instanceof Error ? error.message : 'Unknown error'
          },
          source: 'slack_service'
        }])
    }
  }

  async sendRSSProcessingAlert(success: boolean, campaignId?: string, error?: string) {
    if (success) {
      await this.sendAlert(
        `RSS processing completed successfully${campaignId ? ` for campaign ${campaignId}` : ''}`,
        'info',
        'rss_processing_updates'
      )
    } else {
      await this.sendAlert(
        `RSS processing failed: ${error}`,
        'error',
        'rss_processing_updates'
      )
    }
  }

  async sendEmailCampaignAlert(type: 'review' | 'final', success: boolean, campaignId: string, error?: string) {
    const actionText = type === 'review' ? 'Review campaign' : 'Final campaign'

    if (success) {
      await this.sendAlert(
        `${actionText} sent successfully for campaign ${campaignId}`,
        'info',
        'email_delivery_updates'
      )
    } else {
      await this.sendAlert(
        `${actionText} failed for campaign ${campaignId}: ${error}`,
        'error',
        'email_delivery_updates'
      )
    }
  }

  async sendSystemAlert(message: string, level: 'info' | 'warn' | 'error') {
    await this.sendAlert(`System Alert: ${message}`, level, 'system_errors')
  }

  async sendHealthCheckAlert(component: string, status: 'healthy' | 'degraded' | 'down', details?: string) {
    const level = status === 'healthy' ? 'info' : status === 'degraded' ? 'warn' : 'error'
    const message = `Health Check: ${component} is ${status}${details ? ` - ${details}` : ''}`

    await this.sendAlert(message, level, 'health_check_alerts')
  }
}

// Error handler utility
export class ErrorHandler {
  private slack: SlackNotificationService

  constructor() {
    this.slack = new SlackNotificationService()
  }

  async handleError(error: Error | unknown, context: {
    source: string
    operation?: string
    campaignId?: string
    userId?: string
    [key: string]: any
  }) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined

    // Log to database
    await supabaseAdmin
      .from('system_logs')
      .insert([{
        level: 'error',
        message: errorMessage,
        context: {
          ...context,
          stack: errorStack
        },
        source: context.source
      }])

    // Send Slack alert for critical errors
    if (this.isCriticalError(context.source, errorMessage)) {
      await this.slack.sendAlert(
        `Critical error in ${context.source}${context.operation ? ` during ${context.operation}` : ''}: ${errorMessage}`,
        'error',
        'system_errors'
      )
    }

    console.error(`Error in ${context.source}:`, error)
  }

  private isCriticalError(source: string, message: string): boolean {
    const criticalSources = ['rss_processor', 'mailerlite_service', 'auth_system']
    const criticalKeywords = ['failed to process', 'authentication failed', 'database error', 'api timeout']

    return criticalSources.includes(source) ||
           criticalKeywords.some(keyword => message.toLowerCase().includes(keyword))
  }

  async logInfo(message: string, context: Record<string, any> = {}, source: string = 'system') {
    await supabaseAdmin
      .from('system_logs')
      .insert([{
        level: 'info',
        message,
        context,
        source
      }])
  }

  async logWarning(message: string, context: Record<string, any> = {}, source: string = 'system') {
    await supabaseAdmin
      .from('system_logs')
      .insert([{
        level: 'warn',
        message,
        context,
        source
      }])

    // Send Slack notification for warnings
    await this.slack.sendAlert(`Warning: ${message}`, 'warn', 'system_errors')
  }
}

// Health monitoring utilities
export class HealthMonitor {
  private slack: SlackNotificationService
  private errorHandler: ErrorHandler

  constructor() {
    this.slack = new SlackNotificationService()
    this.errorHandler = new ErrorHandler()
  }

  async checkRSSFeeds() {
    try {
      const { data: feeds, error } = await supabaseAdmin
        .from('rss_feeds')
        .select('*')
        .eq('active', true)

      if (error) throw error

      const failedFeeds = feeds.filter(feed => feed.processing_errors > 5)

      if (failedFeeds.length > 0) {
        await this.slack.sendHealthCheckAlert(
          'RSS Feeds',
          'degraded',
          `${failedFeeds.length} feeds have multiple processing errors`
        )
      }

      return { healthy: failedFeeds.length === 0, failedFeeds }
    } catch (error) {
      await this.errorHandler.handleError(error, {
        source: 'health_monitor',
        operation: 'checkRSSFeeds'
      })
      return { healthy: false, error }
    }
  }

  async checkDatabaseConnection() {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_logs')
        .select('id')
        .limit(1)

      if (error) throw error

      return { healthy: true }
    } catch (error) {
      await this.slack.sendHealthCheckAlert(
        'Database',
        'down',
        'Unable to connect to Supabase database'
      )
      return { healthy: false, error }
    }
  }

  async checkRecentProcessing() {
    try {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)

      const { data: campaigns, error } = await supabaseAdmin
        .from('newsletter_campaigns')
        .select('*')
        .gte('created_at', yesterday.toISOString())

      if (error) throw error

      if (campaigns.length === 0) {
        await this.slack.sendHealthCheckAlert(
          'RSS Processing',
          'degraded',
          'No campaigns created in the last 24 hours'
        )
        return { healthy: false, reason: 'No recent campaigns' }
      }

      return { healthy: true, recentCampaigns: campaigns.length }
    } catch (error) {
      await this.errorHandler.handleError(error, {
        source: 'health_monitor',
        operation: 'checkRecentProcessing'
      })
      return { healthy: false, error }
    }
  }

  async runFullHealthCheck() {
    const results = {
      database: await this.checkDatabaseConnection(),
      rssFeeds: await this.checkRSSFeeds(),
      recentProcessing: await this.checkRecentProcessing(),
      timestamp: new Date().toISOString()
    }

    const overallHealth = Object.values(results).every(result =>
      typeof result === 'object' && 'healthy' in result ? result.healthy : true
    )

    await this.errorHandler.logInfo('Health check completed', {
      results,
      overallHealth
    }, 'health_monitor')

    if (!overallHealth) {
      await this.slack.sendSystemAlert(
        'System health check failed - some components are not healthy',
        'warn'
      )
    }

    return results
  }
}