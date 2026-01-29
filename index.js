import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import { Client } from '@notionhq/client';
import Anthropic from '@anthropic-ai/sdk';

// Initialize clients
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Cache for Notion content (refreshes every 5 minutes)
let sopCache = {
  content: '',
  lastFetched: 0,
  cacheDuration: 5 * 60 * 1000, // 5 minutes
};

/**
 * Fetches all SOP content from Notion
 */
async function fetchSOPContent() {
  const now = Date.now();

  // Return cached content if still valid
  if (sopCache.content && (now - sopCache.lastFetched) < sopCache.cacheDuration) {
    console.log('Using cached SOP content');
    return sopCache.content;
  }

  console.log('Fetching fresh SOP content from Notion...');

  try {
    // Search for all pages the integration has access to
    const searchResponse = await notion.search({
      filter: {
        property: 'object',
        value: 'page',
      },
      sort: {
        direction: 'descending',
        timestamp: 'last_edited_time',
      },
    });

    let allContent = [];

    for (const page of searchResponse.results) {
      try {
        // Get page title
        const title = getPageTitle(page);

        // Get page content (blocks)
        const blocks = await getPageBlocks(page.id);
        const content = blocksToText(blocks);

        if (content.trim()) {
          allContent.push(`\n## ${title}\n\n${content}`);
        }
      } catch (error) {
        console.error(`Error fetching page ${page.id}:`, error.message);
      }
    }

    const fullContent = allContent.join('\n\n---\n');

    // Update cache
    sopCache.content = fullContent;
    sopCache.lastFetched = now;

    console.log(`Fetched ${searchResponse.results.length} pages from Notion`);
    return fullContent;
  } catch (error) {
    console.error('Error fetching from Notion:', error);
    // Return cached content if available, even if stale
    if (sopCache.content) {
      console.log('Returning stale cache due to error');
      return sopCache.content;
    }
    throw error;
  }
}

/**
 * Extract page title from Notion page object
 */
function getPageTitle(page) {
  if (page.properties?.title?.title?.[0]?.plain_text) {
    return page.properties.title.title[0].plain_text;
  }
  if (page.properties?.Name?.title?.[0]?.plain_text) {
    return page.properties.Name.title[0].plain_text;
  }
  // Try to find any title property
  for (const [key, value] of Object.entries(page.properties || {})) {
    if (value.type === 'title' && value.title?.[0]?.plain_text) {
      return value.title[0].plain_text;
    }
  }
  return 'Untitled';
}

/**
 * Recursively fetch all blocks from a page
 */
async function getPageBlocks(pageId, depth = 0) {
  if (depth > 3) return []; // Limit recursion depth

  const blocks = [];
  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      blocks.push(block);

      // Recursively fetch children if block has children
      if (block.has_children) {
        const children = await getPageBlocks(block.id, depth + 1);
        blocks.push(...children);
      }
    }

    cursor = response.next_cursor;
  } while (cursor);

  return blocks;
}

/**
 * Convert Notion blocks to plain text
 */
function blocksToText(blocks) {
  return blocks.map(block => {
    const type = block.type;
    const content = block[type];

    if (!content) return '';

    switch (type) {
      case 'paragraph':
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
      case 'bulleted_list_item':
      case 'numbered_list_item':
      case 'quote':
      case 'callout':
        return richTextToPlain(content.rich_text);

      case 'code':
        return `\`\`\`\n${richTextToPlain(content.rich_text)}\n\`\`\``;

      case 'to_do':
        const checkbox = content.checked ? '[x]' : '[ ]';
        return `${checkbox} ${richTextToPlain(content.rich_text)}`;

      case 'toggle':
        return richTextToPlain(content.rich_text);

      case 'divider':
        return '---';

      default:
        return '';
    }
  }).filter(text => text.trim()).join('\n');
}

/**
 * Convert Notion rich text to plain text
 */
function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText.map(t => t.plain_text || '').join('');
}

/**
 * Ask Claude a question using the SOP content as context
 */
async function askClaude(question, sopContent) {
  const systemPrompt = `You are the Arabnb SOP Assistant, a helpful AI assistant for the Arabnb holiday home and short-term rental company.
Your role is to help team members find information in the company's Standard Operating Procedures (SOPs).

When answering questions:
1. Be concise but thorough
2. Reference specific sections of the SOPs when relevant
3. If the information isn't in the SOPs, say so clearly
4. Format your responses for Slack (use *bold*, _italic_, and bullet points)
5. If a question is unclear, ask for clarification
6. Be friendly and professional

Here is the current SOP documentation:

${sopContent}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: question,
      },
    ],
  });

  return response.content[0].text;
}

// Handle direct messages to the bot
app.message(async ({ message, say }) => {
  // Ignore bot messages
  if (message.subtype === 'bot_message') return;

  console.log(`Received message: ${message.text}`);

  try {
    // Show typing indicator
    await say({
      text: 'Searching the SOPs... :mag:',
      thread_ts: message.ts,
    });

    // Fetch SOP content
    const sopContent = await fetchSOPContent();

    if (!sopContent) {
      await say({
        text: "I don't have access to any SOP pages yet. Please make sure to add the 'Arabnb SOP Bot' integration to your Notion pages.",
        thread_ts: message.ts,
      });
      return;
    }

    // Ask Claude
    const answer = await askClaude(message.text, sopContent);

    // Send response
    await say({
      text: answer,
      thread_ts: message.ts,
    });
  } catch (error) {
    console.error('Error processing message:', error);
    await say({
      text: `Sorry, I encountered an error: ${error.message}. Please try again or contact support.`,
      thread_ts: message.ts,
    });
  }
});

// Handle @mentions in channels
app.event('app_mention', async ({ event, say }) => {
  console.log(`Mentioned in channel: ${event.text}`);

  // Remove the bot mention from the message
  const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!question) {
    await say({
      text: "Hi! I'm the Arabnb SOP Assistant. Ask me anything about our standard operating procedures! :book:",
      thread_ts: event.ts,
    });
    return;
  }

  try {
    // Show typing indicator
    await say({
      text: 'Let me check the SOPs for you... :mag:',
      thread_ts: event.ts,
    });

    // Fetch SOP content
    const sopContent = await fetchSOPContent();

    if (!sopContent) {
      await say({
        text: "I don't have access to any SOP pages yet. Please make sure to add the 'Arabnb SOP Bot' integration to your Notion pages.",
        thread_ts: event.ts,
      });
      return;
    }

    // Ask Claude
    const answer = await askClaude(question, sopContent);

    // Send response
    await say({
      text: answer,
      thread_ts: event.ts,
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    await say({
      text: `Sorry, I encountered an error: ${error.message}. Please try again.`,
      thread_ts: event.ts,
    });
  }
});

// Handle the app_home_opened event (optional - shows a welcome message in the App Home)
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Welcome to the Arabnb SOP Assistant!* :house_with_garden:',
            },
          },
          {
            type: 'divider',
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "I'm here to help you find information in Arabnb's Standard Operating Procedures.\n\n*How to use me:*\n\n1. *Direct Message:* Send me a message directly to ask questions\n2. *Channel Mention:* Tag me with @Arabnb SOP Assistant in any channel\n\n*Example questions:*\n- What's the check-in process?\n- How do I handle a guest complaint?\n- What are the cleaning procedures?\n- How do I report a maintenance issue?",
            },
          },
          {
            type: 'divider',
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: ':bulb: The SOPs are automatically synced from Notion, so I always have the latest information!',
              },
            ],
          },
        ],
      },
    });
  } catch (error) {
    console.error('Error publishing home view:', error);
  }
});

// Start the app
(async () => {
  await app.start();
  console.log(':zap: Arabnb SOP Bot is running!');

  // Initial fetch of SOP content
  try {
    const content = await fetchSOPContent();
    if (content) {
      console.log('Successfully loaded SOP content from Notion');
    } else {
      console.log('Warning: No SOP content found. Make sure the integration has page access in Notion.');
    }
  } catch (error) {
    console.log('Warning: Could not fetch initial SOP content:', error.message);
  }
})();
