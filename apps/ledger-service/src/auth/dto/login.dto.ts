import { IsByteLength, IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  // Та сама межа, що й при реєстрації: не даємо ганяти bcrypt по мегабайтних рядках.
  @IsString()
  @IsByteLength(1, 72)
  password: string;
}
