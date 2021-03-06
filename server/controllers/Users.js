import bcrypt from 'bcryptjs';
import models from '../database/models';

import {
  serverResponse,
  serverError,
  generateToken,
  expiryDate,
  getUserAgent,
  sendVerificationEmail,
  sendResetPasswordEmail,
  verifyResetPasswordToken,
  userResponse
} from '../helpers';

const { User, Session, ResetPassword } = models;

/**
 * @export
 * @class Users
 */
class Users {
  /**
   * @name create
   * @async
   * @static
   * @memberof Users
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} JSON object with details of new user
   */
  static async create(req, res) {
    try {
      if (await User.findByEmail(req.body.email)) {
        return serverResponse(res, 409, {
          error: 'email has already been taken'
        });
      }
      if (await User.findByUsername(req.body.userName)) {
        return serverResponse(res, 409, {
          error: 'username has already been taken'
        });
      }

      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      const user = await User.create({
        ...req.body,
        password: hashedPassword
      });

      const { devicePlatform, userAgent } = getUserAgent(req);
      const { id } = user;
      const token = generateToken({ id }, '24h');
      const expiresAt = expiryDate(devicePlatform);

      await Session.create({
        userId: id,
        token,
        expiresAt,
        userAgent,
        ipAddress: req.ip,
        devicePlatform
      });

      res.set('Authorization', token);
      sendVerificationEmail({ ...user.dataValues, token });
      return userResponse(res, 201, user, token);
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * @name verifyUserEmail
   * @async
   * @static
   * @description function that sends email for password reset
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} success message when email is sent
   */
  static async verifyUserEmail(req, res) {
    try {
      const { user } = req;
      if (user.verified) {
        return serverResponse(res, 200, { message: 'email already verified' });
      }
      await User.update({ verified: true }, { where: { email: user.email } });
      return serverResponse(res, 200, {
        message: 'email verification successful'
      });
    } catch (error) {
      return serverError(res);
    }
  }

  /** @name resendVerificationEmail
   * @async
   * @static
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} Json response to the user
   */
  static async resendVerificationEmail(req, res) {
    try {
      const { email } = req.params;
      const user = await User.findByEmail(email);
      if (!user) return serverResponse(res, 404, { error: 'user not found' });
      const token = generateToken({ id: user.id }, '24h');
      sendVerificationEmail({ ...user, token });
      return serverResponse(res, 200, { message: 'email sent successfully' });
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   *
   * @name requestPasswordResetLink
   * @static
   * @param {object} req express object
   * @param {object} res express object
   * @memberof Users
   * @returns {JSON} JSON object
   */
  static async requestPasswordResetLink(req, res) {
    try {
      const { email } = req.body;
      const user = await User.findByEmail(email);
      if (!user) {
        return serverResponse(res, 404, {
          message: 'email address not found'
        });
      }
      const { id } = user;
      const token = generateToken({ id }, '1h');
      await ResetPassword.create({ token, userId: id });
      await Session.revokeAll(id);
      sendResetPasswordEmail({ ...user, token });
      return serverResponse(res, 200, {
        message: 'password reset link sent'
      });
    } catch (error) {
      return serverError(res);
    }
  }

  /**
   * @name changePassword
   * @async
   * @static
   * @memberof Users
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {JSON} JSON object with details of new user
   */
  static async changePassword(req, res) {
    const { password } = req.body;
    const { id } = req.user.dataValues;
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.update({ password: hashedPassword }, { where: { id } });
    return serverResponse(res, 200, {
      message: 'password changed successfully'
    });
  }

  /**
   *
   * @static
   * @param {object} req express object
   * @param {object} res express object
   *
   * @memberof Users
   * @returns {JSON} JSON object
   */
  static async resetPassword(req, res) {
    try {
      const { password } = req.body;
      const { token } = req.params;

      const id = await verifyResetPasswordToken(token);
      if (!id) {
        return serverResponse(res, 401, {
          error: 'link has expired or is invalid'
        });
      }
      const resetToken = await ResetPassword.findOne({
        where: { token }
      });
      if (!resetToken) {
        return serverResponse(res, 401, { error: 'link has been used' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.updatePasswordById(id, hashedPassword);
      await ResetPassword.destroy({ where: { token } });
      return serverResponse(res, 200, { message: 'password reset successful' });
    } catch (error) {
      return serverError(res);
    }
  }
}

export default Users;
