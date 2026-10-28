import { IsByteLength, IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  // bcrypt враховує лише перші 72 байти пароля (не символи: кирилиця — 2 байти),
  // решту мовчки відкидає. Довші паролі відхиляємо явно.
  @IsString()
  @MinLength(8)
  @IsByteLength(8, 72)
  password: string;
}
