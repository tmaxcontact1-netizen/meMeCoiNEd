import os
import sys
import json
import asyncio
import logging
from telethon import TelegramClient, events
from telethon.errors import SessionPasswordNeededError
import redis

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] [TELEGRAM] %(message)s')
logger = logging.getLogger(__name__)

# Redis connection
REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379')
redis_parts = REDIS_URL.replace('redis://', '').split(':')
REDIS_HOSTNAME = redis_parts[0] if len(redis_parts) > 0 else 'localhost'
REDIS_PORT = int(redis_parts[1]) if len(redis_parts) > 1 and redis_parts[1].isdigit() else 6379
REDIS_DB = int(redis_parts[2]) if len(redis_parts) > 2 and redis_parts[2].isdigit() else 0

# Telegram credentials
API_ID = int(os.environ.get('TELEGRAM_API_ID', '0'))
API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
SESSION_NAME = 'memecoined_bot'

r = redis.Redis(host=REDIS_HOSTNAME, port=REDIS_PORT, db=REDIS_DB, decode_responses=True)
client = None

def get_auth_status():
    return r.get('telegram:auth:status') or 'idle'

def set_auth_status(status):
    r.set('telegram:auth:status', status)
    r.publish('telegram:auth:update', json.dumps({'status': status}))

async def wait_for_phone():
    """Wait for phone number from Redis (polled from dashboard)"""
    set_auth_status('waiting_phone')
    logger.info("Waiting for phone number...")

    while True:
        phone = r.get('telegram:auth:phone')
        if phone:
            r.delete('telegram:auth:phone')
            return phone
        await asyncio.sleep(1)

async def wait_for_otp():
    """Wait for OTP code from Redis"""
    set_auth_status('waiting_otp')
    logger.info("Waiting for OTP code...")

    while True:
        otp = r.get('telegram:auth:otp')
        if otp:
            r.delete('telegram:auth:otp')
            return otp
        await asyncio.sleep(1)

async def wait_for_password():
    """Wait for 2FA password from Redis"""
    set_auth_status('waiting_password')
    logger.info("Waiting for 2FA password...")

    while True:
        password = r.get('telegram:auth:password')
        if password:
            r.delete('telegram:auth:password')
            return password
        await asyncio.sleep(1)

def save_session(session_string):
    """Save Telethon session string to Redis"""
    r.set('telegram:session', session_string)
    set_auth_status('done')
    logger.info("Session saved to Redis, authentication complete")

def load_session():
    """Load saved session from Redis"""
    return r.get('telegram:session')

async def authenticate(client):
    """Handle the full authentication flow"""
    session_string = load_session()
    if session_string:
        try:
            await client.start(session_string=session_string)
            set_auth_status('done')
            logger.info("Reconnected using saved session")
            return True
        except Exception:
            logger.warning("Saved session invalid, starting fresh auth")

    # Step 1: Get phone number
    phone = await wait_for_phone()
    await client.send_code_request(phone)
    logger.info(f"Code sent to {phone}")

    # Step 2: Get OTP
    otp = await wait_for_otp()
    try:
        await client.sign_in(phone, otp)
        session_str = client.session.save()
        save_session(session_str)
        return True
    except SessionPasswordNeededError:
        # Step 3: 2FA password
        password = await wait_for_password()
        await client.sign_in(password=password)
        session_str = client.session.save()
        save_session(session_str)
        return True

async def monitor_groups():
    """Monitor configured Telegram groups for memecoin mentions"""
    groups_json = r.get('config:telegram')
    groups = json.loads(groups_json) if groups_json else []

    @client.on(events.NewMessage())
    async def handler(event):
        message_text = event.raw_text
        chat = await event.get_chat()
        chat_name = getattr(chat, 'title', 'Unknown')

        # Look for cashtags ($SOMETHING) or contract addresses
        import re
        cashtags = re.findall(r'\$[A-Za-z]+', message_text)
        addresses = re.findall(r'[A-HJ-NP-Za-km-z1-9]{32,44}', message_text)

        if cashtags or addresses:
            mention = {
                'source': 'telegram',
                'group': chat_name,
                'text': message_text,
                'cashtags': cashtags,
                'addresses': addresses,
                'timestamp': event.date.isoformat() if event.date else None,
            }
            r.rpush('sentiment:telegram:mentions', json.dumps(mention))
            r.ltrim('sentiment:telegram:mentions', -2000, -1)
            logger.info(f"[{chat_name}] Mention detected: {cashtags or addresses}")

async def main():
    global client

    if not API_ID or not API_HASH:
        logger.error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
        sys.exit(1)

    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    await client.connect()

    if not await client.is_user_authorized():
        logger.info("User not authorized, beginning auth flow...")
        success = await authenticate(client)
        if not success:
            logger.error("Authentication failed")
            sys.exit(1)
    else:
        set_auth_status('done')
        logger.info("Already authorized")

    # Start monitoring
    await monitor_groups()
    logger.info("Monitoring groups for memecoin mentions...")

    # Keep running
    await client.run_until_disconnected()

if __name__ == '__main__':
    asyncio.run(main())