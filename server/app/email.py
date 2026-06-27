"""Transactional email (verification + password reset).

If ``SMTP_HOST`` is unset the message is LOGGED to stdout instead of sent — so a
fresh self-host can bootstrap (read the verify/reset link from the container
logs) with no mail server configured.
"""

from __future__ import annotations

import logging
from email.message import EmailMessage

log = logging.getLogger("excaliboard")


async def send_email(settings, to: str, subject: str, body: str) -> None:
    if not settings.smtp_host:
        log.warning(
            "[email:stdout] SMTP not configured — would send to %s\n"
            "  Subject: %s\n  %s",
            to,
            subject,
            body.replace("\n", "\n  "),
        )
        return

    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    import aiosmtplib

    await aiosmtplib.send(
        msg,
        hostname=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_user or None,
        password=settings.smtp_pass or None,
        start_tls=settings.smtp_starttls,
    )


async def send_verification(settings, to: str, link: str) -> None:
    await send_email(
        settings,
        to,
        "Confirm your Excaliboard account",
        f"Welcome to Excaliboard!\n\nConfirm your email to start drawing:\n{link}\n\n"
        f"This link expires in {settings.verify_ttl_seconds // 3600} hours. "
        "If you didn't sign up, ignore this email.",
    )


async def send_reset(settings, to: str, link: str) -> None:
    await send_email(
        settings,
        to,
        "Reset your Excaliboard password",
        f"Reset your password with the link below:\n{link}\n\n"
        f"This link expires in {settings.reset_ttl_seconds // 60} minutes. "
        "If you didn't request this, ignore this email — your password is unchanged.",
    )
