
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendDeletionConfirmationEmail(userEmail, token) {
  const confirmationUrl = `https://test.itc.today/api/user/confirm-deletion?token=${token}`;

  const mailOptions = {
    from: `ITC <${process.env.SMTP_FROM_EMAIL}>`,
    to: userEmail,
    subject: '[ITC] 회원 탈퇴 확인 안내',
    html: `
      <p>안녕하세요.</p>
      <p>ITC 회원 탈퇴를 요청하셨습니다. 탈퇴를 완료하려면 아래 버튼을 클릭해주세요.</p>
      <a href="${confirmationUrl}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: #fff; text-decoration: none; border-radius: 5px;">탈퇴 완료하기</a>
      <p>이 요청을 하지 않으셨다면 이 이메일을 무시하셔도 됩니다.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Deletion confirmation email sent to ${userEmail}`);
  } catch (error) {
    console.error(`Error sending email to ${userEmail}:`, error);
    throw error;
  }
}

module.exports = { sendDeletionConfirmationEmail };
