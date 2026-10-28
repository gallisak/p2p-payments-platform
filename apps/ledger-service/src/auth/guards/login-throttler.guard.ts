import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

// Ліміт спроб логіну рахується за парою "IP + email", а не лише за IP:
// фронтенд проксіює логін через свій сервер, тож для ledger-service усі
// користувачі приходять з однієї адреси, і ліміт за IP блокував би всіх разом.
// Лічильники зберігаються в пам'яті процесу (стандартне сховище throttler):
// для одного екземпляра сервісу цього досить, для кількох потрібне спільне
// сховище (Redis).
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: {
    ip?: string;
    body?: { email?: unknown };
  }): Promise<string> {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    return `${req.ip}:${email}`;
  }
}
