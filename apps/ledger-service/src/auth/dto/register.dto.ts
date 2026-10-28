import { IsByteLength, IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @IsByteLength(8, 72)
  password: string;
}
